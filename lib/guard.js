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
const SHELL_TOOLS = new Set(["bash", "pwsh", "cmd", "run_script"]);

/** shell 工具的命令文本字段：bash/pwsh/cmd 用 command，run_script 用 script。 */
const COMMAND_FIELD = { bash: "command", pwsh: "command", cmd: "command", run_script: "script" };

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

// ── 命令位置边界 ────────────────────────────────────────────────────────
// 只在「命令开始处」认下载器：行首 / 语句分隔符 / 管道 / 子 shell / 引号 /
// 反引号 / 赋值号之后（允许其后的空白）。这样 `C:\curl\notes.txt` 这类**路径**
// 不会被误判成 curl 命令；`echo curl` 也不会。
const CMD_START = String.raw`(?:^|[;&|({"'\x60=]\s*)`;
const CMD_END = String.raw`(?=[\s;&|)'"\x60,]|$)`;

/** 下载器清单：[展示名, 正则]。aria2c 单独放在最前：它默认就写文件，不需要额外旗标。 */
const DOWNLOADERS = [
	["aria2c", /aria2c\b/i],
	["curl", new RegExp(`${CMD_START}curl(?:\\.[A-Za-z]+)?${CMD_END}`, "i")],
	["wget", new RegExp(`${CMD_START}wget(?:\\.[A-Za-z]+)?${CMD_END}`, "i")],
	["Invoke-WebRequest", new RegExp(`${CMD_START}Invoke-WebRequest\\b`, "i")],
	["Start-BitsTransfer", new RegExp(`${CMD_START}(?:Start-)?BitsTransfer\\b`, "i")]
];

// ── 「明确落盘」证据 ────────────────────────────────────────────────────
const FLAG_START = String.raw`(?:^|[\s'"\x60])`;
const FLAG_END = String.raw`(?=[\s'"=,;)]|$)`;

const WRITE_FLAG_PATTERNS = [
	new RegExp(`${FLAG_START}-o${FLAG_END}`),
	new RegExp(`${FLAG_START}--output${FLAG_END}`),
	new RegExp(`${FLAG_START}-O${FLAG_END}`),
	new RegExp(`${FLAG_START}--remote-name${FLAG_END}`),
	new RegExp(`${FLAG_START}--output-document${FLAG_END}`),
	new RegExp(`${FLAG_START}-OutFile${FLAG_END}`, "i")
];

/** 重定向到文件；排除 `2>&1` / `>&2`（紧邻 `&`）与 `->`、`=>`。 */
const FILE_REDIRECT_RE = /(?:^|[^=<>-])>{1,2}(?!&)\s*[^\s>|&]/;

/** URL token（http/https/ftp）：后缀证据只看 URL，避免把 `curl.exe` 的 `.exe` 当成大文件。 */
const URL_TOKEN_RE = /(?:https?|ftp):\/\/[^\s'"\x60]+/gi;

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
		alternatives.push(withDot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	}
	if (alternatives.length === 0) return null;
	return new RegExp(`(?:${alternatives.join("|")})(?![A-Za-z0-9.])`, "i");
}

/** 命令里是否有「URL 以大文件后缀结尾」。 */
function hasLargeExtensionUrl(text, matcher) {
	if (matcher === null) return false;
	for (const match of text.matchAll(URL_TOKEN_RE)) {
		if (matcher.test(match[0])) return true;
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

/** 在命令文本里找下载器；返回展示名或 null。 */
function findDownloader(text) {
	for (const [displayName, pattern] of DOWNLOADERS) {
		if (pattern.test(text)) return displayName;
	}
	return null;
}

/** 是否有「显式写出文件」的旗标。 */
function hasWriteFlag(text) {
	return WRITE_FLAG_PATTERNS.some((pattern) => pattern.test(text));
}

/** deny 文案：短、可执行，只在拦截时进入模型上下文一次。 */
function denyReason(downloader) {
	return `下载守卫拦截：${downloader} 下载大文件请改用 motrix（action=download，多线程/断点续传/磁力），不要再从 shell 拉；确需放行可在 guardAllowPatterns 加白名单正则。`;
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
		)
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
	if (!SHELL_TOOLS.has(toolName)) return null;

	const args = exec.arguments;
	if (!args || typeof args !== "object") return null;
	const text = args[COMMAND_FIELD[toolName]];
	if (typeof text !== "string" || !text.trim()) return null;

	// 白名单最优先：用户显式放行的模式永远放行。
	if (state.allowPatterns.some((pattern) => pattern.test(text))) return null;

	const downloader = findDownloader(text);
	if (!downloader) return null;

	const landsOnDisk =
		downloader === "aria2c" || hasWriteFlag(text) || FILE_REDIRECT_RE.test(text) || hasLargeExtensionUrl(text, state.extensionMatcher);

	return landsOnDisk ? { kind: "deny", reason: denyReason(downloader) } : null;
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
