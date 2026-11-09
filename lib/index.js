/**
 * dsh-motrix — Motrix 大文件下载工具插件。
 *
 * 通过本机 `@motrix/cli` 命令行客户端驱动正在运行的 Motrix 桌面应用
 * （或 Motrix server），向模型暴露一个网关工具 motrix（action = download | tasks | manage）：
 *
 *   - action=download：添加 HTTP(S)/FTP/磁力/种子下载任务，默认等待完成；
 *   - action=tasks：   查看任务列表与全局速度统计；
 *   - action=manage：  暂停 / 恢复 / 移除任务（op=pause|resume|remove）。
 *
 * motrix CLI 是「客户端而非下载引擎」：本插件每次调用都 spawn 一个
 * 一次性 CLI 进程，用 `--json` 取机器可读输出；桥接不可达（exit 3/6）时
 * 自动执行一次 `motrix open` 拉起桌面应用后重试。实际传输由 Motrix 完成，
 * 因此本工具调用超时或中止都不会中断已开始的下载。
 *
 * 依赖：按官方规范以 peer 形式声明 `@deepseek-ai/dsh-tools`（官方
 * defineTool / 参数 DSL）与 `@deepseek-ai/schemastery`（官方 Config
 * Standard Schema），package.json 的 peerDependencies + devDependencies
 * 同时列出二者；link 安装下 profile 解析层按 peer 申报把请求路由到宿主
 * 运行时自带的副本，因此与宿主共享同一份实例（官方文档 04「linked
 * checkout 的 peer 规则」）。
 *
 * Config（写在 profile / bundle patch 的 config 段；完整键与默认值以下方 Config schema
 * 为准，这里只列常用项）：
 *   cliCommand            Motrix CLI 命令或入口，默认 "motrix"
 *   nodeCommand           运行 .js 入口用的 node，空 = 自动探测
 *   autoOpen              桥接不可达时自动拉起桌面应用，默认 true
 *   launchHidden          静默拉起（--opened-at-login=1，不弹主窗口），默认 true
 *   motrixExePath         Motrix 主程序路径，空 = 自动探测（静默拉起用）
 *   openTimeoutMs         拉起后等待桥接就绪的上限，默认 45000
 *   cliTimeoutMs          单次 CLI 调用上限，默认 30000
 *   addTimeoutMs          add 子命令上限，默认 60000
 *   pollIntervalMs        等待循环轮询间隔，默认 2000
 *   defaultWaitTimeoutMs  默认等待预算，默认 600000
 *   downloadToolTimeoutMs motrix action=download 工具整体上限，默认 960000
 *   listLimit             motrix action=tasks 默认条数，默认 30
 *   maxUrlsPerCall        单次最多 URL 数，默认 8
 *   endpoint              远端 Motrix server 地址，默认 ""（本机）
 *   token                 桥接 token，默认 ""（走 CLI 的 pair 结果）
 *
 * @module dsh-motrix
 */
import Schema from "@deepseek-ai/schemastery";
import { createGuardState, decideGuard, guardConfigSchema } from "./guard.js";
import { createRunner } from "./runner.js";
import { registerMotrixTools } from "./tools.js";

/** Cordis 插件名（loader 诊断用）。 */
const name = "tool-motrix";
/** 依赖的宿主服务：工具注册器与系统提示组装。 */
const inject = ["tools", "systemPrompt"];

/**
 * 官方配置契约：导出 Standard Schema（Schemastery）的 Config。
 * Cordis 在插件加载时按它校验该行的 config 并填充默认值；不合法即响亮失败。
 * 正整数项用 `.min(1).step(1)` 表达原来的「正整数」约束（官方文档 03：
 * 不要导出普通对象作为 Config）。
 */
const Config = Schema.object({
	cliCommand: Schema.string().default("motrix").description("Motrix CLI 命令、可执行文件路径或 .js 入口（默认 \"motrix\"，即 PATH 上的 @motrix/cli）"),
	nodeCommand: Schema.string().default("").description("运行 .js 入口用的 node 命令；留空自动探测（退回 Electron 自带 Node）"),
	autoOpen: Schema.boolean().default(true).description("桥接不可达（exit 3/6）时自动拉起桌面应用后重试（默认 true）"),
	launchHidden: Schema.boolean().default(true).description("静默拉起：直接以 `--opened-at-login=1` 启动 Motrix 主程序，不弹主窗口（Windows/macOS 默认 true）；false 回退旧 `motrix open`（会显示窗口）"),
	motrixExePath: Schema.string().default("").description("Motrix 主程序绝对路径（静默拉起用；留空自动探测常见安装位置）"),
	openTimeoutMs: Schema.number().default(45000).min(1).step(1).description("拉起后等待桥接就绪的上限毫秒数（默认 45000）"),
	cliTimeoutMs: Schema.number().default(30000).min(1).step(1).description("单次 motrix CLI 调用上限毫秒数（默认 30000）"),
	addTimeoutMs: Schema.number().default(60000).min(1).step(1).description("`motrix add` 子命令上限毫秒数（默认 60000）"),
	pollIntervalMs: Schema.number().default(2000).min(1).step(1).description("等待完成时轮询任务列表的间隔毫秒数（默认 2000）"),
	defaultWaitTimeoutMs: Schema.number().default(600000).min(1).step(1).description("motrix action=download 默认等待预算毫秒数（默认 600000）"),
	downloadToolTimeoutMs: Schema.number().default(960000).min(1).step(1).description("motrix action=download 工具整体超时毫秒数（默认 960000，须大于等待预算）"),
	// codereview #445：描述承诺「上限 200」——schema 层补上 .max(200)，配置超限在加载期响亮失败
	//（与文件头「不合法即响亮失败」一致；tools.js 的运行时 clamp 保留作纵深防御）
	listLimit: Schema.number().default(30).min(1).step(1).max(200).description("motrix action=tasks 默认返回条数（默认 30，上限 200）"),
	maxUrlsPerCall: Schema.number().default(8).min(1).step(1).description("motrix action=download 单次调用允许的最大 URL 数量（默认 8）"),
	stallWindowMs: Schema.number().default(60000).min(0).step(1).description("等待期间判定「停滞」的时长毫秒数（无字节增长超过此时长则提前返回；0 = 关闭，默认 60000）"),
	staleAfterMs: Schema.number().default(60000).min(1000).step(1).description("motrix action=tasks 标记 stale（长时间无进展）的时长毫秒数（默认 60000）"),
	useWatch: Schema.boolean().default(true).description("等待完成时用 `motrix watch --json` 事件流降低轮询频率（失败自动回退到轮询；默认 true）"),
	watchPollMs: Schema.number().default(5000).min(500).step(1).description("watch 事件流存活时的安全轮询间隔毫秒数（默认 5000）"),
	idempotent: Schema.boolean().default(true).description("用桥接层 idempotencyKey 派生稳定键，重复调用不会建重复任务（桥接不可用时回落 CLI；默认 true）"),
	// 内置下载守卫（从 dsh-plugin-motrix-guard 合并）：没有工具/提示词，常驻 token 为 0。
	...guardConfigSchema,
	endpoint: Schema.string().default("").description("远端 Motrix server 地址；留空走本机桥接（默认空）"),
	token: Schema.string().default("").description("Motrix 桥接 token（MOTRIX_BRIDGE_TOKEN）；留空用 CLI 已 pair 的凭证（默认空）")
});

/** 注入系统提示的使用指引；仅在工具对当前 scope 可见时出现。 */
const SYSTEM_SECTION_TEXT =
	"Motrix for large/slow links, magnet/.torrent; resumable, not curl; outlives the call.";

/** 注册全部工具与系统提示。config 已由 Cordis 按 Config schema 校验并填好默认值。 */
function apply(ctx, config) {
	// 这里只做形状规整（去掉 CLI 命令两端空白、endpoint 先去空白再去尾斜杠、token 去空白），
	// 不再合并默认值。codereview #446：带空白的脏值会原样进 CLI 的 --endpoint 参数与
	// MOTRIX_BRIDGE_TOKEN 环境变量，桥接/远端连接失败难定位。
	config = {
		...config,
		cliCommand: String(config.cliCommand).trim(),
		endpoint: String(config.endpoint).trim().replace(/\/+$/, ""),
		token: String(config.token).trim()
	};
	// codereview #240：跨字段契约显式校验——downloadToolTimeoutMs 须大于 defaultWaitTimeoutMs
	// 且留出至少 30s 的提交/轮询余量。tools.js 的等待预算 = min(waitTimeoutMs,
	// downloadToolTimeoutMs - 30000)：只校验「大于」时，35000/30000 这种配置能通过，
	// 预算却被压到 5s，等于静默改写调用方意图。非法配置应在加载时响亮失败
	//（官方「配置错误要响亮」，不做静默回落）。
	if (config.downloadToolTimeoutMs < config.defaultWaitTimeoutMs + 30000) {
		throw new Error(
			`tool-motrix 配置错误：downloadToolTimeoutMs (${config.downloadToolTimeoutMs}) 必须至少比 defaultWaitTimeoutMs (${config.defaultWaitTimeoutMs}) 大 30000ms，` +
				`否则等待预算会被静默压缩，下载工具可能过早超时。`
		);
	}
	const runner = createRunner(config);
	// 官方规范：插件自有资源（这里是一次性 CLI 子进程）经 ctx.effect 声明清理，
	// 禁用/HMR 卸载时统一终止，避免等待循环继续 spawn。
	ctx.effect(() => () => runner.dispose());
	// 内置下载守卫：tools/pre-execute 上拦截 shell 大文件下载；自身异常一律 next()。
	const guardState = createGuardState(config, ctx?.logger);
	ctx.on("tools/pre-execute", async (exec, next) => {
		try {
			return decideGuard(exec, guardState) ?? next();
		} catch {
			return next();
		}
	});

	ctx.systemPrompt.section({
		name: "tool:motrix",
		order: 2050,
		text: ({ scope }) => ctx.tools.get("motrix", scope) === undefined ? "" : SYSTEM_SECTION_TEXT
	});

	registerMotrixTools(ctx, config, { runner });
}

export { Config, apply, inject, name };
