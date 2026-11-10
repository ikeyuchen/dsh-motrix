/**
 * dsh-motrix / lib/guard.js
 * ================================
 * 内置下载守卫（从独立插件 dsh-plugin-motrix-guard 合并而来，2026-10-19）：
 * 在 `tools/pre-execute` waterfall 上做一次窄口径检查——shell 类工具里出现
 * 「下载器 + 确实落盘 + 大文件证据」就返回 deny，把模型引导到 motrix
 * （action=download）。
 *
 * 为什么合并：守卫没有模型可见工具、没有提示词段，常驻 token 为 0；
 * 合进来后只装一个插件即可同时获得「下载工具 + 使用纪律」。
 *
 * 边界：只拦「大文件」——证据是 URL 后缀或显式输出文件名后缀命中
 * guardLargeExtensions；小文件（.json/.txt/.sh… 或没有后缀）、`curl URL`
 * （写 stdout）、`curl -o /dev/null`、`-o -`、`curl -I`、`wget --spider`、
 * `curl URL | tar xz` 等全部放行（尺寸未知按小文件处理，宁可漏拦不误拦）。
 * `git clone`、`npm install`、`Get-ChildItem` 同样放行；守卫自身异常一律
 * next()（不打断流水线）。
 */
import Schema from "@deepseek-ai/schemastery";

/** 只对这几类 shell 执行工具生效；其余工具一律放行。 */
const SHELL_TOOLS = new Set(["bash", "pwsh", "cmd", "run_script", "ops_bash"]);

/** shell 工具的命令文本字段：多数用 command，run_script 用 script。 */
const COMMAND_FIELD = {
	bash: "command",
	pwsh: "command",
	cmd: "command",
	run_script: "script",
	ops_bash: "command"
};

/** 「大文件」后缀默认值（Config.guardLargeExtensions 的出厂值）。 */
const DEFAULT_LARGE_EXTENSIONS = [
	".iso",
	".img",
	".zip",
	".7z",
	".rar",
	".dmg",
	".pkg",
	".msi",
	".exe",
	".bin",
	".tar",
	".gz",
	".xz",
	".mp4",
	".mkv"
];

// ── 命令位置识别 ────────────────────────────────────────────────────────
// 不用「单个前导字符集」：先按 shell 运算符把命令文本切成简单命令段，再跳过
// 包装前缀（sudo/env/timeout/xargs…）与变量赋值，只有段的第一个真实命令词是
// 下载器才算命中。这样 `grep -rn aria2c .`、`echo curl` 不会误判，而
// `sudo curl …`、`cd /tmp\ncurl …`、`/usr/bin/curl …` 都能命中。
const SEGMENT_CHAR_RE = /[;&|\n\r{}()]/;
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPER_ARG_RE = /^(?:-\d+|--?[A-Za-z][\w-]*|\d+(?:\.\d+)?[smhd]?|[A-Za-z_][A-Za-z0-9_]*=\S*)$/;
const WRAPPERS = new Set([
	"sudo",
	"doas",
	"command",
	"env",
	"timeout",
	"nice",
	"nohup",
	"exec",
	"xargs",
	"setsid",
	"stdbuf",
	"ionice",
	"time",
	"builtin",
	"wsl",
	"then",
	"do",
	"else",
	"elif",
	"if",
	"while",
	"until",
	"!"
]);
const SHELL_WORDS = new Set(["sh", "bash", "zsh", "dash", "fish", "pwsh", "powershell", "cmd"]);
const SHELL_COMMAND_FLAGS = new Set(["-c", "/c", "-command", "--command"]);
/** 合并短选项里的 -c：`bash -lc` / `sh -ec`（长度上限避免把 -ExecutionPolicy 之类长选项当内联旗标）。 */
const SHELL_INLINE_CLUSTER_RE = /^-(?!-)[A-Za-z]{1,4}$/;
const COMMAND_EXT_RE = /\.(?:exe|bat|cmd|ps1)$/i;

/** 下载器命令词 → deny 文案里的展示名。 */
const DOWNLOADERS = new Map([
	["curl", "curl"],
	["wget", "wget"],
	["aria2c", "aria2c"],
	["iwr", "Invoke-WebRequest"],
	["invoke-webrequest", "Invoke-WebRequest"],
	["bitsadmin", "bitsadmin"],
	["start-bitstransfer", "BitsTransfer"],
	["certutil", "certutil"]
]);

/**
 * 默认就写文件的下载器：调用即落盘，不需要额外旗标
 * （wget 同样默认落盘，但 `-O -` / `-qO-` / `--spider` 例外，单独处理）。
 */
const DEFAULT_TO_DISK = new Set(["aria2c", "bitsadmin", "BitsTransfer", "certutil"]);

/** 去掉 token 两端的引号/反引号（保留内部内容）。 */
function cleanToken(raw) {
	return String(raw).replace(/^[`'"]+/, "").replace(/[`'"]+$/, "");
}

/** token 的命令词：去引号、取路径 basename（`/usr/bin/curl`、`.\curl.exe`）、去扩展名、小写。 */
function commandWord(raw) {
	const token = cleanToken(raw);
	const base = token.split(/[\\/]/).pop() || "";
	return base.replace(COMMAND_EXT_RE, "").toLowerCase();
}

/** `bash -c '…'` / `cmd /c …` / `pwsh -Command …`：把内联命令文本再判一遍。 */
function inlineShellCommand(tokens, startIndex) {
	for (let index = startIndex + 1; index < tokens.length; index++) {
		const flag = cleanToken(tokens[index]).toLowerCase();
		const merged = SHELL_INLINE_CLUSTER_RE.test(flag) && flag.includes("c");
		if (!SHELL_COMMAND_FLAGS.has(flag) && !merged) continue;
		const rest = tokens.slice(index + 1).join(" ").trim();
		if (!rest) return null;
		// 内联命令外层的那一对引号由 shell 解释，再判前要去掉；尾随的 `2>/dev/null`、
		// `>log` 等重定向不影响内联文本本身，只取引号内的部分。
		const first = rest[0];
		if (first === "'" || first === '"' || first === "`") {
			const close = rest.indexOf(first, 1);
			if (close > 0) return rest.slice(1, close);
		}
		return rest;
	}
	return null;
}

/**
 * 按 shell 运算符切简单命令段。引号内的运算符不切，
 * 否则 `curl -o 'data(beta).zip'`、`-d '{"a":"b"}'` 会被切成两段而丢掉文件名。
 */
function splitSegments(text) {
	const segments = [];
	let current = "";
	let quote = "";
	for (const char of text) {
		if (quote !== "") {
			current += char;
			if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			current += char;
			continue;
		}
		if (SEGMENT_CHAR_RE.test(char)) {
			segments.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	segments.push(current);
	return segments;
}

/**
 * 一个简单命令段里的「命令位置」：
 * - `{ display, text }`：该段就是下载器调用，text 供后续证据分析；
 * - `{ inner }`：该段是 shell 包装，需要递归判定内联命令；
 * - `null`：不是下载器。
 */
function inspectSegment(segment) {
	const tokens = segment.trim().split(/\s+/).filter(Boolean);
	let index = 0;
	while (index < tokens.length) {
		const token = cleanToken(tokens[index]);
		if (ASSIGNMENT_RE.test(token)) {
			index++;
			continue;
		}
		const word = commandWord(tokens[index]);
		if (SHELL_WORDS.has(word)) {
			const inline = inlineShellCommand(tokens, index);
			return inline === null ? null : { inner: inline };
		}
		if (WRAPPERS.has(word)) {
			// `command -v curl` / `builtin -p curl` 只是查询，不是执行下载器
			if ((word === "command" || word === "builtin") && tokens[index + 1] && cleanToken(tokens[index + 1]).startsWith("-")) {
				return null;
			}
			index++;
			while (index < tokens.length) {
				const argument = cleanToken(tokens[index]);
				if (!argument) {
					index++;
					continue;
				}
				if (ASSIGNMENT_RE.test(argument) || WRAPPER_ARG_RE.test(argument)) {
					index++;
					continue;
				}
				break;
			}
			continue;
		}
		const display = DOWNLOADERS.get(word);
		if (display === undefined) return null;
		if (display === "certutil" && !tokens.some((item) => /^-{1,2}urlcache\b/i.test(cleanToken(item)))) return null;
		return { display, text: segment };
	}
	return null;
}

// ── 「落盘 + 大文件」证据 ──────────────────────────────────────────────
const FLAG_START = String.raw`(?:^|[\s'"\x60=,;(])`;
const FLAG_END = String.raw`(?=[\s'"\x60=,;)]|$)`;

/** curl 只取头/不落盘：`-I`（含 -sI 之类的字符簇）、`-X HEAD`、`--head`、`--spider`。 */
const CURL_HEAD_ONLY_RE = new RegExp(
	String.raw`${FLAG_START}-(?!-)[A-Za-z]*I[A-Za-z]*${FLAG_END}|${FLAG_START}-X\s+[Hh][Ee][Aa][Dd]${FLAG_END}|${FLAG_START}--head${FLAG_END}|${FLAG_START}--spider${FLAG_END}`
);

/** curl 按远端文件名落盘：`-O`（含 -OJ、-sLO 之类的字符簇）、`--remote-name`。 */
const REMOTE_NAME_RE = new RegExp(
	String.raw`${FLAG_START}--remote-name(?:-all)?${FLAG_END}|${FLAG_START}-(?!-)[A-Za-z]*O[A-Za-z]*${FLAG_END}`
);

/** wget 只取头：`--spider`。 */
const WGET_SPIDER_RE = new RegExp(String.raw`${FLAG_START}--spider${FLAG_END}`);

/** aria2c 只探测/查看文件、不下载：`--dry-run`（默认 true，`=false` 不算）、`-S/--show-files`。 */
const ARIA2C_PROBE_RE = new RegExp(
	String.raw`${FLAG_START}--(?:dry-run|show-files)(?:=(?:true|1))?(?![A-Za-z0-9=])${FLAG_END}|${FLAG_START}-(?!-)[A-Za-z]*S[A-Za-z]*${FLAG_END}`
);

/**
 * 重定向写文件；排除 `2>&1` / `>&2`（紧邻 `&`）、`->`、`=>`，
 * 以及前置字符为数字/`*` 的 fd 重定向（`2>…`、`1>…`、`*>`）。
 * 目标归一化后再排除 `/dev/null`、`NUL`、`$null` 这些假落盘。
 */
const FILE_REDIRECT_RE = new RegExp(String.raw`(?:^|[^=<>0-9*])>{1,2}(?!&)\s*([^\s>|&]+)`);

/** 不是「本地真实文件」的落盘目标：stdout / 空设备。 */
const NON_FILE_TARGETS = new Set(["-", "/dev/null", "/dev/stdout", "/dev/stderr", "nul", "$null"]);

const TOKEN_BOUNDARY_RE = /[\s;&|(){}<>]/;

/** 命令段分词：引号内整体保留并去掉成对引号，shell 运算符与重定向符视作分隔。 */
function tokenize(text) {
	const tokens = [];
	let current = "";
	let quote = "";
	const flush = () => {
		if (current) {
			tokens.push(current);
			current = "";
		}
	};
	for (const char of text) {
		if (quote) {
			if (char === quote) quote = "";
			else current += char;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (TOKEN_BOUNDARY_RE.test(char)) {
			flush();
			continue;
		}
		current += char;
	}
	flush();
	return tokens;
}

/** 短选项取值（区分大小写）：`-o x` / `-ofoo` / `-sLo x` / `-o=x`。 */
function collectShortOutputTargets(tokens, chars) {
	const targets = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.length < 2 || !token.startsWith("-") || token.startsWith("--")) continue;
		const body = token.slice(1);
		const equals = body.indexOf("=");
		const name = equals === -1 ? body : body.slice(0, equals);
		const equalsValue = equals === -1 ? "" : body.slice(equals + 1);
		for (const char of chars) {
			const position = name.indexOf(char);
			if (position === -1) continue;
			const inline = equalsValue || name.slice(position + 1);
			const next = tokens[index + 1];
			if (inline) targets.push(inline);
			else if (next !== undefined && !next.startsWith("--")) targets.push(next);
			break;
		}
	}
	return targets;
}

/** 长选项取值：`--out file` / `--out=file`（名字区分大小写，与真实 CLI 一致）。 */
function collectLongOutputTargets(tokens, names) {
	const targets = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!token.startsWith("--")) continue;
		const body = token.slice(2);
		const equals = body.indexOf("=");
		const name = `--${equals === -1 ? body : body.slice(0, equals)}`;
		if (!names.includes(name)) continue;
		const inline = equals === -1 ? "" : body.slice(equals + 1);
		const next = tokens[index + 1];
		if (inline) targets.push(inline);
		else if (next !== undefined) targets.push(next);
	}
	return targets;
}

/** PowerShell 的 `-OutFile <path>` / `-OutFile:<path>`（不区分大小写）。 */
function collectOutFileTargets(tokens) {
	const targets = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.startsWith("--") || !/^-outfile/i.test(token)) continue;
		const inline = token.slice("-OutFile".length).replace(/^[:=]/, "");
		const next = tokens[index + 1];
		if (inline) targets.push(inline);
		else if (next !== undefined) targets.push(next);
	}
	return targets;
}

/** 下载器的显式「输出到文件」旗标语义（短选项区分大小写）。 */
const OUTPUT_FLAG_SPECS = {
	curl: { short: ["o"], long: ["--output"] },
	wget: { short: ["O"], long: ["--output-document"] },
	aria2c: { short: ["o"], long: ["--out"] }
};

/** PowerShell 风格的长参数取值（`-Destination x` / `-Destination:x`，不区分大小写）。 */
function collectPowerShellTargets(tokens, name) {
	const targets = [];
	const lower = name.toLowerCase();
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.startsWith("--") || !token.toLowerCase().startsWith(lower)) continue;
		const inline = token.slice(name.length).replace(/^[:=]/, "");
		const next = tokens[index + 1];
		if (inline) targets.push(inline);
		else if (next !== undefined) targets.push(next);
	}
	return targets;
}

/** 收集命令里「显式写出的文件目标」（尚未判断是否真文件）。 */
function collectOutputTargets(text, downloader) {
	const tokens = tokenize(text);
	if (downloader === "Invoke-WebRequest") return collectOutFileTargets(tokens);
	if (downloader === "BitsTransfer") return [...collectPowerShellTargets(tokens, "-Destination"), ...collectPowerShellTargets(tokens, "-Dest")];
	if (downloader === "bitsadmin" || downloader === "certutil") {
		// 两者的目标文件都是最后一个位置参数（bitsadmin /transfer <name> <url> <file>；
		// certutil -urlcache -f <url> [file]）；没有目标时最后一个 token 是 URL，不算。
		const last = tokens[tokens.length - 1];
		if (last === undefined || URL_PREFIX_RE.test(last)) return [];
		return [last];
	}
	const spec = OUTPUT_FLAG_SPECS[downloader];
	if (spec === undefined) return [];
	return [...collectShortOutputTargets(tokens, spec.short), ...collectLongOutputTargets(tokens, spec.long)];
}

/** 收集重定向目标。 */
function collectRedirectTargets(text) {
	const targets = [];
	let remaining = text;
	for (;;) {
		const match = FILE_REDIRECT_RE.exec(remaining);
		if (match === null) return targets;
		targets.push(cleanToken(match[1]));
		remaining = remaining.slice(match.index + match[0].length);
	}
}

/** 落盘目标是不是本地真实文件（stdout、/dev/null、NUL、$null 都不算）。 */
function isRealFileTarget(raw) {
	const target = cleanToken(String(raw)).toLowerCase();
	if (!target) return false;
	return !NON_FILE_TARGETS.has(target);
}

const URL_PREFIX_RE = /^(?:https?|ftp):\/\/\S+/i;

/**
 * 取值是「元数据」而不是下载源的参数：其后的 URL 只算引用/头信息，不算大文件证据
 * （如 `curl -e https://…/a.zip`、`-H '…'`、`--data …`）。
 * 只收「取值可能是一个裸 URL」的参数；短选项区分大小写，`-O`（curl 按远端名落盘、
 * wget 写文件）与 `-c`（wget 续传）都不能算，否则会漏掉真正的下载 URL。
 */
const NON_SOURCE_URL_FLAGS = new Set([
	"-e",
	"-H",
	"-b",
	"-d",
	"-F",
	"-T",
	"-x",
	"-A",
	"-u",
	"-o",
	"-D",
	"-U",
	"-X",
	"-w",
	"-r",
	"-K",
	"-E",
	"-m",
	"-P",
	"-a",
	"--referer",
	"--header",
	"--cookie",
	"--cookie-jar",
	"--data",
	"--data-raw",
	"--data-binary",
	"--data-urlencode",
	"--data-ascii",
	"--form",
	"--upload-file",
	"--proxy",
	"--preproxy",
	"--user-agent",
	"--user",
	"--request",
	"--write-out",
	"--range",
	"--limit-rate",
	"--max-filesize",
	"--config",
	"--interface",
	"--output",
	"--output-document",
	"--out",
	"--directory-prefix",
	"--append-output",
	"--post-data",
	"--body-data",
	"--method",
	"--load-cookies",
	"--save-cookies",
	"--ca-certificate",
	"--certificate",
	"--private-key",
	"--password",
	"--dump-header"
]);

/** 该 token 是否是「其值是元数据、不是下载源」的参数。 */
function isNonSourceFlag(token) {
	return NON_SOURCE_URL_FLAGS.has(token.startsWith("--") ? token.toLowerCase() : token);
}

/**
 * 收集命令里的下载源 URL：token 以 http(s)/ftp 开头，且前一个 token 不是
 * 元数据参数（`-e`/`-H`/`--data` 等）。
 */
function collectUrlTokens(text) {
	const tokens = tokenize(text);
	const urls = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!URL_PREFIX_RE.test(token)) continue;
		if (index > 0 && isNonSourceFlag(tokens[index - 1])) continue;
		urls.push(token);
	}
	return urls;
}

/** 正则元字符集合（后缀编译用；逐字符转义，避免使用带 g 的 replace 正则）。 */
const REGEXP_SPECIAL_CHARS = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

/** 转义一段文本里的正则元字符。 */
function escapeRegExp(text) {
	let escaped = "";
	for (const char of text) {
		escaped += REGEXP_SPECIAL_CHARS.has(char) ? `\\${char}` : char;
	}
	return escaped;
}

/**
 * 把后缀列表编译成正则：后缀后不能紧跟字母数字或点（避免 `iso.example.com` 误伤）。
 * @param {string[]} extensions
 * @returns {RegExp | null}
 */
function compileExtensionMatcher(extensions) {
	const alternatives = [];
	for (const raw of extensions) {
		if (typeof raw !== "string") continue;
		const trimmed = raw.trim().toLowerCase();
		if (!trimmed) continue;
		const withDot = trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
		alternatives.push(escapeRegExp(withDot));
	}
	if (alternatives.length === 0) return null;
	return new RegExp(`(?:${alternatives.join("|")})(?![A-Za-z0-9.])`, "i");
}

/**
 * URL 的最后一个路径段（去掉查询串/锚点）。后缀证据只看文件名，
 * 避免 `x.iso/child.json`、`export?filename=backup.zip` 这类路径/参数误判。
 */
function urlFileName(url) {
	const withoutQuery = url.split(/[?#]/)[0];
	const slash = withoutQuery.lastIndexOf("/");
	return slash === -1 ? withoutQuery : withoutQuery.slice(slash + 1);
}

/** 命令里是否有「URL 以大文件后缀结尾」。 */
function hasLargeExtensionUrl(text, matcher) {
	for (const url of collectUrlTokens(text)) {
		if (matcher.test(urlFileName(url))) return true;
	}
	return false;
}

/** 显式输出目标（-o/-O/-OutFile/重定向）里是否有大文件后缀。 */
/**
 * PowerShell 的 `-OutFile` / `-Destination` 可以接表达式：
 * `-OutFile (Join-Path $env:TEMP 'x.zip')` / `-Destination ($dir + '\x.zip')`。
 * 表达式里的后缀同样算大文件证据。
 */
const PS_EXPRESSION_TARGET_RE = /-(?:outfile|destination)\s*(?::|=)?\s*(\([^)]*\))/gi;

/** 取命令里所有 PowerShell 表达式目标（match 会重置 lastIndex，避免 /g 状态残留）。 */
function psExpressionTargets(text) {
	return text.match(PS_EXPRESSION_TARGET_RE) ?? [];
}

/** 显式输出目标（-o/-O/-OutFile/重定向/表达式）里是否有大文件后缀。 */
function hasLargeTarget(text, downloader, matcher, fullText) {
	const targets = [...collectOutputTargets(text, downloader), ...collectRedirectTargets(text)];
	if (targets.some((target) => isRealFileTarget(target) && matcher.test(target))) return true;
	if (downloader === "Invoke-WebRequest" || downloader === "BitsTransfer") {
		return psExpressionTargets(fullText).some((expression) => matcher.test(expression));
	}
	return false;
}

/** 这次调用是否真的把内容写到本地文件（stdout、/dev/null、只取头都不算）。 */
function writesToFile(text, downloader, fullText) {
	if (downloader === "curl") {
		if (CURL_HEAD_ONLY_RE.test(text)) return false;
		if (collectOutputTargets(text, downloader).some(isRealFileTarget)) return true;
		if (REMOTE_NAME_RE.test(text)) return true;
		return collectRedirectTargets(text).some(isRealFileTarget);
	}
	if (downloader === "wget") {
		// wget 默认写当前目录；`--spider` 只取头，`-O -` / `--output-document=-` 写 stdout。
		if (WGET_SPIDER_RE.test(text)) return false;
		const targets = collectOutputTargets(text, downloader);
		return targets.length === 0 || targets.some(isRealFileTarget);
	}
	if (downloader === "Invoke-WebRequest") {
		// iwr 不带 -OutFile 只把响应读进内存；表达式目标（`-OutFile (Join-Path …)`）也算落盘。
		if (collectOutputTargets(text, downloader).some(isRealFileTarget)) return true;
		return psExpressionTargets(fullText).length > 0;
	}
	if (downloader === "aria2c" && ARIA2C_PROBE_RE.test(text)) return false;
	return DEFAULT_TO_DISK.has(downloader);
}

/**
 * 这段命令是否是「下载器下载大文件到本地」。
 * 只有落盘且 URL/输出名命中大文件后缀才成立：小文件与尺寸未知一律放行，
 * 不因为出现 -o/-O 之类的旗标就拦截。
 */
function downloadsLargeFile(text, downloader, matcher, fullText) {
	if (matcher === null) return false;
	if (!writesToFile(text, downloader, fullText)) return false;
	if (hasLargeTarget(text, downloader, matcher, fullText)) return true;
	return hasLargeExtensionUrl(text, matcher);
}

/** 命令段是否命中「下载大文件」；命中返回下载器展示名。 */
function findLargeDownload(text, matcher) {
	for (const segment of splitSegments(text)) {
		const hit = inspectSegment(segment);
		if (hit === null) continue;
		if (hit.inner !== undefined) {
			const inner = findLargeDownload(hit.inner, matcher);
			if (inner !== null) return inner;
			continue;
		}
		if (downloadsLargeFile(hit.text, hit.display, matcher, text)) return hit.display;
	}
	return null;
}

/** 编译 allowPatterns；非法正则记一次警告后忽略（配置小毛病不影响插件加载）。 */
function compileAllowPatterns(patterns, logger) {
	const compiled = [];
	for (const raw of patterns) {
		if (typeof raw !== "string" || !raw.trim()) continue;
		try {
			compiled.push(new RegExp(raw, "i"));
		} catch (error) {
			try {
				logger?.warn?.(`[motrix-guard] guardAllowPatterns 里的正则无法编译，已忽略: ${raw} (${error?.message ?? error})`);
			} catch {}
		}
	}
	return compiled;
}

/** deny 文案：短、可执行，只在拦截时进入模型上下文一次。 */
function denyReason(downloader) {
	return `下载守卫拦截：${downloader} 下载的是大文件（URL/输出文件名命中 guardLargeExtensions），改用 motrix（action=download，多线程/断点续传/磁力）更快更稳；小文件可直接下载，确需 shell 拉大文件可在 guardAllowPatterns 加白名单正则。`;
}

/** 看起来像 shell 执行器、但不在 SHELL_TOOLS 里的工具名（G8 兜底提示，每个名字只警告一次）。 */
const SHELLISH_TOOL_RE = /(?:^|[_-])(?:bash|sh|shell|pwsh|powershell|cmd|exec|script|terminal|command)(?:$|[_-])/i;

/** 对未覆盖的 shell 类工具名 warn 一次，方便发现守卫静默失效。 */
function warnUnmatchedShellTool(state, toolName) {
	if (!toolName || !SHELLISH_TOOL_RE.test(toolName)) return;
	const warned = state.warnedToolNames ?? (state.warnedToolNames = new Set());
	if (warned.has(toolName)) return;
	warned.add(toolName);
	try {
		state.logger?.warn?.(
			`[motrix-guard] 工具名 "${toolName}" 看起来是 shell 执行器，但不在守卫覆盖列表内（${[...SHELL_TOOLS].join("/")}），该工具不会被下载守卫拦截；如属新 shell 工具请更新 lib/guard.js 的 SHELL_TOOLS。`
		);
	} catch {}
}

/**
 * 由插件 Config 构造一次判定状态（apply 时构造一次，热路径只读）。
 * @param {object} config
 * @param {object} [logger]
 */
function createGuardState(config, logger) {
	return {
		enabled: config?.guardEnabled !== false,
		allowPatterns: compileAllowPatterns(Array.isArray(config?.guardAllowPatterns) ? config.guardAllowPatterns : [], logger),
		extensionMatcher: compileExtensionMatcher(
			Array.isArray(config?.guardLargeExtensions) ? config.guardLargeExtensions : DEFAULT_LARGE_EXTENSIONS
		),
		logger,
		warnedToolNames: new Set()
	};
}

/**
 * 判定一次工具调用。
 * @param {unknown} exec ToolExecution：{ name, arguments, signal, ... }
 * @param {{ enabled: boolean, allowPatterns: RegExp[], extensionMatcher: RegExp | null }} state
 * @returns {{ kind: "deny", reason: string } | null} null = 放行
 */
function decideGuard(exec, state) {
	if (!state.enabled) return null;
	const toolName = exec && typeof exec.name === "string" ? exec.name : "";
	if (!SHELL_TOOLS.has(toolName)) {
		warnUnmatchedShellTool(state, toolName);
		return null;
	}

	const args = exec.arguments;
	if (!args || typeof args !== "object") return null;
	const text = args[COMMAND_FIELD[toolName]];
	if (typeof text !== "string" || !text.trim()) return null;

	// 白名单最优先：用户显式放行的模式永远放行。
	if (state.allowPatterns.some((pattern) => pattern.test(text))) return null;

	const downloader = findLargeDownload(text, state.extensionMatcher);
	return downloader === null ? null : { kind: "deny", reason: denyReason(downloader) };
}

/** Config 片段：内置守卫的三个字段（由 index.js 并入主 Config）。 */
const guardConfigSchema = {
	guardEnabled: Schema.boolean()
		.default(true)
		.description("内置下载守卫：拦截 shell 里下载器下载大文件（URL/输出文件名命中 guardLargeExtensions），引导改用 motrix（默认 true）"),
	guardAllowPatterns: Schema.array(Schema.string())
		.default([])
		.description("下载守卫的正则白名单：命令文本命中任一即放行（大小写不敏感；非法正则被忽略）（默认 []）"),
	guardLargeExtensions: Schema.array(Schema.string())
		.default(DEFAULT_LARGE_EXTENSIONS)
		.description("下载守卫视为大文件的后缀列表（默认 .iso/.img/.zip 等 15 项；匹配 URL 与输出文件名）")
};

export { createGuardState, decideGuard, DEFAULT_LARGE_EXTENSIONS, guardConfigSchema };
