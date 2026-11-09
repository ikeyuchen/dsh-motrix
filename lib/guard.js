/**
 * dsh-motrix / lib/guard.js
 * ================================
 * 内置下载守卫（从独立插件 dsh-plugin-motrix-guard 合并而来，2026-10-19）：
 * 在 `tools/pre-execute` waterfall 上做一次窄口径检查——shell 类工具里出现
 * 「下载器 + 明确落盘」就返回 deny，把模型引导到 motrix（action=download）。
 *
 * 为什么合并：守卫没有模型可见工具、没有提示词段，常驻 token 为 0；
 * 合进来后只装一个插件即可同时获得「下载工具 + 使用纪律」。
 *
 * 边界：只拦 shell 工具里的明确信号；`curl https://api…/status`、`git clone`、
 * `npm install`、`Get-ChildItem` 全部放行；守卫自身异常一律 next()（不打断流水线）。
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
const SEGMENT_SPLIT_RE = /[;&|\n\r{}()]+/;
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
 * 默认就写文件的下载器：调用即落盘，不需要额外旗标。
 * wget 也有默认落盘，但 `-O -` / `-qO-` / `--spider` 例外，单独处理。
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
		if (!SHELL_COMMAND_FLAGS.has(flag)) continue;
		const rest = tokens.slice(index + 1).join(" ").trim();
		return rest || null;
	}
	return null;
}

/** 在一个简单命令段里，找出处于「命令位置」的下载器（跳过包装前缀与赋值）。 */
function findDownloaderInSegment(segment) {
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
			if (inline === null) return null;
			const inner = findDownloader(inline);
			return inner === null ? null : { display: inner.display, piped: inner.piped };
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
		return { display, piped: false };
	}
	return null;
}

/**
 * 命令文本里是否出现了处于命令位置的下载器。
 * 返回 `{ display, piped }`：`piped` = 该命令之后还有管道（输出进下一条命令，
 * 不落本地磁盘）；后缀证据只在非管道场景才单独成立。
 */
function findDownloader(text) {
	let remaining = text;
	let offset = 0;
	for (;;) {
		const match = SEGMENT_SPLIT_RE.exec(remaining);
		const segment = match === null ? remaining : remaining.slice(0, match.index);
		const found = findDownloaderInSegment(segment);
		if (found !== null) {
			const piped = Boolean(found.piped) || text.indexOf("|", offset) !== -1;
			return { display: found.display, piped };
		}
		if (match === null) return null;
		offset += match.index + match[0].length;
		remaining = remaining.slice(match.index + match[0].length);
	}
}

// ── 「明确落盘」证据 ────────────────────────────────────────────────────
// 旗标前的边界字符 + 旗标后的边界：支持 `-o x`、`-o=x`、`'-o'`、`(-o` 等写法。
const FLAG_START = String.raw`(?:^|[\s'"\x60=,;(])`;
const FLAG_END = String.raw`(?=[\s'"\x60=,;)]|$)`;

const OUTPUT_FLAG_PATTERNS = [
	// 短选项字符簇里带 o/O 就算写盘：-o file / -O / -OJ / -sLO / -ofoo / -Ofoo。
	// 双横线长选项（--output-dir 等）不在此列，由下面的显式完整词规则判定。
	new RegExp(String.raw`${FLAG_START}-(?!-)[A-Za-z]*[oO][A-Za-z]*${FLAG_END}`),
	new RegExp(String.raw`${FLAG_START}--output${FLAG_END}`),
	new RegExp(String.raw`${FLAG_START}--remote-name${FLAG_END}`),
	new RegExp(String.raw`${FLAG_START}--output-document${FLAG_END}`)
];

/** PowerShell 的显式落盘参数（iwr / Invoke-WebRequest）。 */
const OUT_FILE_FLAG_PATTERNS = [new RegExp(String.raw`${FLAG_START}-OutFile${FLAG_END}`, "i")];

/** curl 只取头/不落盘：`-I`（含 -sI 之类的字符簇）、`--head`、`--spider`。 */
const CURL_HEAD_ONLY_RE = new RegExp(
	String.raw`${FLAG_START}-(?!-)[A-Za-z]*I[A-Za-z]*${FLAG_END}|${FLAG_START}--head${FLAG_END}|${FLAG_START}--spider${FLAG_END}`
);

/** wget 只取头：`--spider`。 */
const WGET_SPIDER_RE = new RegExp(String.raw`${FLAG_START}--spider${FLAG_END}`);

/** wget 输出到 stdout（不是落盘）：`-O -` / `-O-` / `-qO-`。 */
const WGET_TO_STDOUT_RE = new RegExp(String.raw`${FLAG_START}-[A-Za-z]*O[A-Za-z]*\s*-${FLAG_END}`);

/**
 * 重定向写文件；排除 `2>&1` / `>&2`（紧邻 `&`）、`->`、`=>`，
 * 以及前置字符为数字/`*` 的 fd 重定向（`2>…`、`1>…`、`*>`）。
 * 目标归一化后再排除 `/dev/null`、`NUL`、`$null` 这些假落盘。
 */
const FILE_REDIRECT_RE = new RegExp(String.raw`(?:^|[^=<>0-9*])>{1,2}(?!&)\s*([^\s>|&]+)`);
const NON_FILE_TARGETS = new Set(["/dev/null", "nul", "$null"]);

/** 命令里是否有「写到真实文件」的重定向。 */
function hasFileRedirect(text) {
	let remaining = text;
	for (let match = FILE_REDIRECT_RE.exec(remaining); match !== null; match = FILE_REDIRECT_RE.exec(remaining)) {
		const target = cleanToken(match[1]).toLowerCase();
		if (!NON_FILE_TARGETS.has(target)) return true;
		remaining = remaining.slice(match.index + match[0].length);
	}
	return false;
}

/** 是否有「显式写出文件」的旗标；语义按下载器区分（curl/wget 用 -o/-O，iwr 用 -OutFile）。 */
function hasWriteFlag(text, downloader) {
	const patterns = downloader === "Invoke-WebRequest" ? OUT_FILE_FLAG_PATTERNS : OUTPUT_FLAG_PATTERNS;
	return patterns.some((pattern) => pattern.test(text));
}

const QUOTED_PART_RE = /(["'])([^"']*)\1/;
const URL_PREFIX_RE = /^(?:https?|ftp):\/\/\S+/i;

/**
 * 收集命令里的 URL 候选（引号感知）：
 * - 裸 token 以 http(s)/ftp 开头即候选；
 * - 引号内的整段内容只有「就是一个 URL」才算题；`-H 'Referer: https://…/a.iso'`
 *   这种 header 值整段不是 URL，因此后缀只出现在 header 值里时不会仅凭后缀判定。
 */
function collectUrlTokens(text) {
	const tokens = [];
	const chunks = text.split(QUOTED_PART_RE);
	for (let index = 0; index < chunks.length; index++) {
		const chunk = chunks[index];
		if (typeof chunk !== "string") continue;
		const position = index % 3;
		if (position === 2) {
			const trimmed = chunk.trim();
			if (URL_PREFIX_RE.test(trimmed)) tokens.push(trimmed);
			continue;
		}
		if (position !== 0) continue;
		for (const raw of chunk.split(/\s+/)) {
			const token = cleanToken(raw);
			if (token && URL_PREFIX_RE.test(token)) tokens.push(token);
		}
	}
	return tokens;
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

/** 命令里是否有「URL 以大文件后缀结尾」。 */
function hasLargeExtensionUrl(text, matcher) {
	if (matcher === null) return false;
	for (const url of collectUrlTokens(text)) {
		if (matcher.test(url)) return true;
	}
	return false;
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
	return `下载守卫拦截：${downloader} 下载大文件请改用 motrix（action=download，多线程/断点续传/磁力），不要再从 shell 拉；确需放行可在 guardAllowPatterns 加白名单正则。`;
}

/**
 * 这次调用是否真的写盘。
 * @param {string} text
 * @param {string} downloader
 * @param {RegExp | null} matcher
 * @param {boolean} piped 下载器输出是否进了管道（`curl URL | tar xz` 这类不落盘）
 */
function writesToDisk(text, downloader, matcher, piped) {
	if (DEFAULT_TO_DISK.has(downloader)) return true;
	if (downloader === "wget") {
		// wget 无旗标也写当前目录；只取头（--spider）或输出到 stdout（-O -）不算。
		if (WGET_SPIDER_RE.test(text) || WGET_TO_STDOUT_RE.test(text)) return false;
		return true;
	}
	if (hasWriteFlag(text, downloader)) return true;
	if (hasFileRedirect(text)) return true;
	// 只取头时（-I/--head/--spider）不落盘，大文件后缀不能单独定罪。
	if (downloader === "curl" && CURL_HEAD_ONLY_RE.test(text)) return false;
	// 输出进管道时（`… | tar xz`）也不落本地磁盘，后缀同样不能单独定罪。
	return !piped && hasLargeExtensionUrl(text, matcher);
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

	const found = findDownloader(text);
	if (!found) return null;

	return writesToDisk(text, found.display, state.extensionMatcher, found.piped)
		? { kind: "deny", reason: denyReason(found.display) }
		: null;
}

/** Config 片段：内置守卫的三个字段（由 index.js 并入主 Config）。 */
const guardConfigSchema = {
	guardEnabled: Schema.boolean()
		.default(true)
		.description("内置下载守卫：拦截 shell 里 curl/wget 等大文件下载，引导改用 motrix（action=download，默认 true）"),
	guardAllowPatterns: Schema.array(Schema.string())
		.default([])
		.description("下载守卫的正则白名单：命令文本命中任一即放行（大小写不敏感；非法正则被忽略）（默认 []）"),
	guardLargeExtensions: Schema.array(Schema.string())
		.default(DEFAULT_LARGE_EXTENSIONS)
		.description("下载守卫视为大文件的后缀列表（默认 .iso/.img/.zip 等 15 项，只看 URL 后缀）")
};

export { createGuardState, decideGuard, DEFAULT_LARGE_EXTENSIONS, guardConfigSchema };
