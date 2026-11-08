/**
 * dsh-motrix / lib/runner.js
 * =================================
 * motrix CLI 子进程管理层（从 lib/index.js 拆出，纯代码移动）：rawSpawn 单次拉起
 * 与输出截取、CLI JSON 解析、失败翻译、.cmd 垫片解析、createRunner（绑定插件
 * 配置的调用器，含桥接自恢复与卸载清理）。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** Motrix bridge 的 endpoint.json 路径（与 @motrix/cli 的 discovery 保持一致）。 */
function bridgeEndpointPath(env = process.env) {
	if (process.platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Motrix", "bridge", "endpoint.json");
	if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Motrix", "bridge", "endpoint.json");
	return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Motrix", "bridge", "endpoint.json");
}

/** 静默拉起桌面应用时传给 Motrix 主程序的参数：应用把它当登录启动处理。
 *  app.asar 的判定是 `process.argv.includes("--opened-at-login=1")`；配合
 *  showMainWindowAtLogin=false 时只建隐藏窗口/托盘（runMode=trayOnly 时完全不建窗口），
 *  因此不会像 `motrix open`（走 motrix:// 协议）那样把主窗口 show/focus 出来。 */
export const HIDDEN_LAUNCH_ARGS = Object.freeze(["--opened-at-login=1"]);

/** 依据配置与常见安装位置解析 Motrix 主程序；找不到返回 undefined（调用方回退 `motrix open`）。 */
export function resolveMotrixExe(config = {}, env = process.env, platform = process.platform) {
	const explicit = String(config?.motrixExePath ?? "").trim();
	if (explicit !== "") return existsSync(explicit) ? explicit : undefined;
	const candidates = [];
	if (platform === "win32") {
		if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, "Programs", "Motrix", "Motrix.exe"));
		for (const base of [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"]]) {
			if (base) candidates.push(join(base, "Motrix", "Motrix.exe"));
		}
	} else if (platform === "darwin") {
		candidates.push("/Applications/Motrix.app/Contents/MacOS/Motrix");
		if (env.HOME) candidates.push(join(env.HOME, "Applications", "Motrix.app", "Contents", "MacOS", "Motrix"));
	}
	return candidates.find((candidate) => existsSync(candidate));
}

/** 中止信号 → 可抛出的 Error（与 rawSpawn 的口径一致）。 */
function abortError(signal) {
	return signal?.reason instanceof Error ? signal.reason : new Error("操作已被取消");
}

/** 可中止的延时；桥接轮询用。 */
function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError(signal));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** CLI 未安装时抛出的可操作错误。 */
class MotrixCliMissingError extends Error {
	constructor(detail) {
		super(
			`Motrix CLI not found${detail ? ` (${detail})` : ""}. Install it with \`npm install -g @motrix/cli@latest\` (requires Node.js >= 22), ` +
				`or point the tool-motrix \`cliCommand\` config at the motrix executable / its .js entry.`
		);
		this.name = "MotrixCliMissingError";
	}
}

/** 单次 spawn：收集输出、超时与中止协作、无 shell 直传 argv；track 集合登记活动子进程供插件卸载时清理。 */
function rawSpawn(command, args, opts = {}) {
	return new Promise((resolve, reject) => {
		// codereview #242：预中止信号先拒——abort 事件早已派发，下面的 addEventListener 永不
		// 触发，子进程会照常 spawn 并跑到超时；以取消原因 reject 让调用方立刻退出
		if (opts.signal?.aborted) {
			reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("操作已被取消"));
			return;
		}
		let child;
		try {
			child = spawn(command, args, {
				windowsHide: true,
				shell: opts.shell === true,
				env: { ...process.env, ...(opts.env ?? {}) }
			});
		} catch (error) {
			reject(error);
			return;
		}
		opts.track?.add(child);
		const cap = opts.maxOutput ?? 8_000_000;
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const append = (current, chunk) => (current.length >= cap ? current : (current + chunk).slice(0, cap));
		child.stdout?.setEncoding("utf8").on("data", (chunk) => {
			stdout = append(stdout, chunk);
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk) => {
			stderr = append(stderr, chunk);
		});
		const onAbort = () => child.kill();
		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer);
			opts.track?.delete(child);
			opts.signal?.removeEventListener("abort", onAbort);
		};
		const timer = opts.timeoutMs !== undefined ? setTimeout(() => {
			timedOut = true;
			child.kill();
		}, opts.timeoutMs) : undefined;
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (error) => {
			cleanup();
			reject(error);
		});
		child.on("close", (code) => {
			cleanup();
			// codereview #242：中止被 kill 后 close 以 code null 回来——若仍 resolve 成 code:-1，
			// 调用方（与 cliFailure）无法区分"用户取消"与"CLI 崩溃"，会报出误导性的 exit -1；
			// 取消一律按取消原因 reject
			if (opts.signal?.aborted) {
				reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("操作已被取消"));
				return;
			}
			resolve({ code: code ?? -1, stdout, stderr, timedOut, command, args });
		});
	});
}

/** 解析 CLI 的 JSON 输出；容忍前后混杂的非 JSON 行（含顶层数组）。 */
function parseCliJson(text) {
	const trimmed = String(text ?? "").trim();
	if (trimmed === "") return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {}
	// codereview #248：先自后向前逐行扫描"看起来像 JSON 的行"（CLI 把结果单行打印，日志
	// 噪音通常整行混杂在前）；再退回首{/[尾}/]的跨度提取。裸跨度会把首尾字符间的噪音
	// 切进串里——常解析失败被静默吞成 undefined（callJson 的调用方会误读为"无数据"），
	// 偶发还能捕获到无关对象返回错数据。数组跨度是新增：此前根本不认顶层数组输出。
	const lines = trimmed.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line.startsWith("{") || line.startsWith("[")) {
			try {
				return JSON.parse(line);
			} catch {}
		}
	}
	for (const [open, close] of [["{", "}"], ["[", "]"]]) {
		const start = trimmed.indexOf(open);
		const end = trimmed.lastIndexOf(close);
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(trimmed.slice(start, end + 1));
			} catch {}
		}
	}
	return undefined;
}

/** motrix CLI 的系统级退出码（CLI 协议约定；tools.js 的 manage 分类判定也用这一份）。
 * codereview #447：裸 2–6 是魔法数；exit 5 是「桥接操作失败」族——同一码也覆盖
 * 「任务 id 不存在」（CLI 措辞写的是 no MDXP bridge，极具误导性），按码分流而非
 * 嗅探英文措辞：CLI 改个说法就退化成通用失败，丢失排查指引。 */
const EXIT_CODES = {
	USAGE_ERROR: 2,
	BRIDGE_UNREACHABLE: 3,
	AUTH_REJECTED: 4,
	BRIDGE_OP_FAILURE: 5,
	APP_NOT_LAUNCHABLE: 6,
};

/** 把 CLI 失败结果翻译成带处置建议的 Error。 */
function cliFailure(result, context) {
	const detail = (result.stderr || result.stdout || "").trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(" | ");
	const where = context ? ` (${context})` : "";
	if (result.timedOut) return new Error(`motrix CLI timed out${where}: ${detail || "no output"}`);
	switch (result.code) {
		case EXIT_CODES.USAGE_ERROR:
			return new Error(`motrix CLI usage error${where}: ${detail || `exit ${result.code}`}`);
		case EXIT_CODES.BRIDGE_UNREACHABLE:
			return new Error(
				`Cannot reach the Motrix bridge${where}: ${detail || "bridge down"}. Ensure the Motrix desktop app is running ` +
					`(the tool tries \`motrix open\` automatically; check the autoOpen config).`
			);
		case EXIT_CODES.AUTH_REJECTED:
			return new Error(
				`Motrix authentication rejected${where}: ${detail || "token missing or invalid"}. Re-run \`motrix pair\` on this machine ` +
					`or set a valid token in the tool-motrix config.`
			);
		case EXIT_CODES.BRIDGE_OP_FAILURE: {
			// codereview #447：按退出码分流（不再 /no MDXP bridge/i 嗅探措辞）——该码族的
			// 实测形态是任务 id 不存在但报文写成桥接问题；指引核对精确 id。
			const message = `motrix CLI failed${where}: ${detail || `exit ${result.code}`}`;
			return new Error(
				`${message} — this exit-code family also fires when the task id does not exist (despite the bridge wording). ` +
					`Re-check the exact ids with motrix (action=tasks) (task names are not ids).`
			);
		}
		case EXIT_CODES.APP_NOT_LAUNCHABLE:
			return new Error(
				`The Motrix desktop app could not be launched${where}: ${detail || "not installed"}. Install Motrix from https://motrix.app ` +
					`(or point the CLI at a reachable Motrix server via the endpoint config).`
			);
		default:
			return new Error(`motrix CLI failed${where}: ${detail || `exit ${result.code}`}`);
	}
}

/** 从 npm 生成的 .cmd 垫片中解析出真正的 .js 入口（避免 shell 注入）。 */
function parseCmdShimJs(shimPath) {
	try {
		const text = readFileSync(shimPath, "utf8");
		const base = dirname(shimPath);
		// 审查修复 #53：尾随 % 设为可选（%?）——旧版 cmd-shim 布局是 "%~dp0\node_modules\..."
		//（dp0 后无 %），原正则永远匹配不到，导致大量垫片落进 shell:true 回退路径。
		const pattern = /%(?:~?dp0)%?([^"]*\.js)/g;
		let match = pattern.exec(text);
		while (match !== null) {
			const candidate = join(base, match[1]);
			if (existsSync(candidate)) return candidate;
			match = pattern.exec(text);
		}
	} catch {}
	return undefined;
}

/** 创建绑定本插件配置的 motrix CLI 调用器。 */
function createRunner(config) {
	let resolved;
	let resolving;
	/** 本 runner 尚在运行的 CLI 子进程；插件卸载时统一终止（官方规范的 ctx.effect 清理义务）。 */
	const activeChildren = new Set();
	/** codereview #241：dispose 闭锁——置位后所有 run 立即 reject，等待循环不再 spawn 孤儿进程。 */
	let disposed = false;
	/** 静默拉起的去重句柄：并发调用只 spawn 一次主程序。 */
	let launching;

	/** Windows 下用 where.exe 定位命令的全部候选路径。
	 * codereview #244：内部探测不接调用方信号——探测自带 8s 短超时；若接了信号，首个调用方
	 * 取消会把 where.exe 杀成 code:-1，共享的解析结果被毒化成 "not found"，并发搭车的其他
	 * 调用方会收到本不该有的 MotrixCliMissingError。 */
	async function whereCandidates(commandName) {
		if (process.platform !== "win32") return [];
		try {
			const found = await rawSpawn("where.exe", [commandName], { timeoutMs: 8000, track: activeChildren });
			if (found.code !== 0) return [];
			return found.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		} catch {
			return [];
		}
	}

	/** 解析运行 .js 入口用的 node 命令；失败则退回 Electron 自带 Node。（同理不带调用方信号，见 #244。） */
	async function resolveNode() {
		if (config.nodeCommand !== "") return { command: config.nodeCommand, extraEnv: {} };
		try {
			const probe = await rawSpawn("node", ["--version"], { timeoutMs: 8000, track: activeChildren });
			if (probe.code === 0) return { command: "node", extraEnv: {} };
		} catch {}
		return { command: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: "1" } };
	}

	/** 解析 motrix 可执行形态（带缓存）。 */
	async function resolveCommand() {
		if (resolved !== undefined) return resolved;
		if (resolving !== undefined) return resolving;
		resolving = (async () => {
			const raw = config.cliCommand || "motrix";
			const looksLikePath = isAbsolute(raw) || raw.includes("\\") || raw.includes("/");
			if (/\.js$/i.test(raw)) {
				const node = await resolveNode();
				resolved = { command: node.command, prefixArgs: [raw], extraEnv: node.extraEnv, shell: false };
				return resolved;
			}
			if (looksLikePath && /\.exe$/i.test(raw)) {
				resolved = { command: raw, prefixArgs: [], extraEnv: {}, shell: false };
				return resolved;
			}
			if (looksLikePath && /\.cmd$/i.test(raw)) {
				const jsEntry = parseCmdShimJs(raw);
				if (jsEntry !== undefined) {
					const node = await resolveNode();
					resolved = { command: node.command, prefixArgs: [jsEntry], extraEnv: node.extraEnv, shell: false };
					return resolved;
				}
				// 审查修复 #53：解析失败不再退回 shell:true（会把调用方可控的任务 id/URL 拼进
				// cmd.exe 命令行，静默丢弃本函数注释声明的防注入缓解）——响亮失败并指引 .js 入口。
				throw new MotrixCliMissingError(
					`cannot safely parse the .cmd shim \`${raw}\`; point the tool-motrix \`cliCommand\` config at the motrix \`.js\` entry or \`.exe\``
				);
			}
			if (process.platform === "win32") {
				const candidates = await whereCandidates(raw);
				const exe = candidates.find((path) => /\.exe$/i.test(path));
				if (exe !== undefined) {
					resolved = { command: exe, prefixArgs: [], extraEnv: {}, shell: false };
					return resolved;
				}
				const cmd = candidates.find((path) => /\.cmd$/i.test(path));
				if (cmd !== undefined) {
					const jsEntry = parseCmdShimJs(cmd);
					if (jsEntry !== undefined) {
						const node = await resolveNode();
						resolved = { command: node.command, prefixArgs: [jsEntry], extraEnv: node.extraEnv, shell: false };
						return resolved;
					}
					// 审查修复 #53：where.exe 分支同理——解析失败响亮失败，不走 shell:true 注入面。
					throw new MotrixCliMissingError(
						`cannot safely parse the .cmd shim \`${cmd}\`; point the tool-motrix \`cliCommand\` config at the motrix \`.js\` entry or \`.exe\``
					);
				}
				// codereview #245：走到这里说明 where.exe 只剩 .exe/.cmd 之外的候选（PATHEXT 常含
				// .JS/.BAT，这类目标 shell:false 直接 spawn 会 EINVAL/EACCES，而 run() 只在 ENOENT
				// 时重解析缓存）——不再盲取 candidates[0] 缓存一个必然失败的目标，响亮失败并指向配置
				if (candidates.length > 0) {
					throw new MotrixCliMissingError(
						`\`${raw}\` resolves to ${candidates[0]}, which cannot be spawned directly (no .exe/.cmd candidate); point the tool-motrix \`cliCommand\` config at the motrix \`.js\` entry or \`.exe\``
					);
				}
				throw new MotrixCliMissingError(`\`${raw}\` not found on PATH`);
			}
			resolved = { command: raw, prefixArgs: [], extraEnv: {}, shell: false };
			return resolved;
		})();
		try {
			return await resolving;
		} finally {
			resolving = undefined;
		}
	}

	/** 运行一次 motrix 命令（不含桥接自恢复）。 */
	async function run(args, opts = {}) {
		// codereview #241：dispose 后不再拉起新的 CLI 子进程——插件卸载/HMR 后，仍在等待的
		// 循环会继续按 pollIntervalMs spawn 一次性进程直到预算耗尽（最长约 16 分钟），产生
		// 无人追踪的孤儿进程；置位后所有 spawn 立即 reject，等待循环随之快速退出
		if (disposed) {
			const err = new Error("tool-motrix runner has been disposed (plugin unloaded); no further CLI processes will be spawned");
			err.code = "MOTRIX_RUNNER_DISPOSED";
			throw err;
		}
		const target = await resolveCommand();
		const fullArgs = [...target.prefixArgs, ...args];
		if (config.endpoint !== "") fullArgs.push("--endpoint", config.endpoint);
		const extraEnv = { ...target.extraEnv };
		if (config.token !== "") extraEnv.MOTRIX_BRIDGE_TOKEN = config.token;
		try {
			return await rawSpawn(target.command, fullArgs, {
				timeoutMs: opts.timeoutMs ?? config.cliTimeoutMs,
				signal: opts.signal,
				env: extraEnv,
				shell: target.shell,
				track: activeChildren
			});
		} catch (error) {
			// codereview #246：任何 spawn 错误（EINVAL/EACCES 等）都重置缓存让下次调用重新解析
			// ——只认 ENOENT 的话，一个坏目标会被永久缓存、后续调用全部反复撞同一堵墙。
			// 取消类异常（AbortError，含 #242 的 reject 路径）不重置：目标本身是好的。
			const isAbort = error?.name === "AbortError" || error?.code === "ABORT_ERR" || error?.code === "MOTRIX_RUNNER_DISPOSED";
			if (!isAbort) resolved = undefined;
			if (error?.code === "ENOENT") {
				throw new MotrixCliMissingError(String(error.message ?? "spawn ENOENT"));
			}
			throw error;
		}
	}

	/** 运行 motrix 命令；桥接不可达时先静默拉起桌面应用（或回退 `motrix open`）再重试一次。 */
	async function call(args, opts = {}) {
		let result = await run(args, opts);
		if ((result.code === 3 || result.code === 6) && config.autoOpen && opts.recover !== false) {
			// codereview #247：自恢复的拉起失败不能顶掉原始的 3/6 诊断——拉起抛错
			//（CLI 缺失/EACCES 等）若任其传播，调用方会看到误导性的 "CLI not found" 而非
			// cliFailure 会给的桥接不可达/应用未装指引；吞掉后仍照常重试一次原命令
			try {
				// 2026-10-30：Windows/macOS 优先直接以 `--opened-at-login=1` 启动主程序。
				// `motrix open` 走 motrix:// 协议，单实例处理器会 show/focus 主窗口（用户看到的弹窗）；
				// 静默路径只建隐藏窗口/托盘。找不到主程序或显式关闭时才回退旧 CLI open。
				let launched = false;
				if (config.launchHidden !== false && config.endpoint === "" && process.platform !== "linux") {
					if (launching === undefined) launching = launchDesktopHidden(opts).finally(() => { launching = undefined; });
					launched = await launching;
				}
				if (!launched) {
					await run(["open", "--timeout", String(config.openTimeoutMs), "--json"], {
						timeoutMs: config.openTimeoutMs + 15000,
						signal: opts.signal
					});
				}
			} catch {
				/* 拉起失败也要试一次原命令；最终失败时以原始 3/6 结果走 cliFailure */
			}
			result = await run(args, { ...opts, recover: false });
		}
		return result;
	}

	/** 要求成功的调用：失败即抛翻译后的 Error，成功返回解析的 JSON（可能为 undefined）。 */
	async function callJson(args, opts = {}) {
		const result = await call(args, opts);
		if (result.code !== 0) throw cliFailure(result, opts.context);
		return parseCliJson(result.stdout);
	}

	/** 解析 bridge 的 baseUrl/token：优先插件配置，其次 endpoint.json / 环境变量；不可用返回 undefined。 */
	function bridgeEndpoint() {
		let baseUrl = config.endpoint.replace(/\/+$/, "");
		let token = config.token;
		if (baseUrl === "") {
			try {
				const file = JSON.parse(readFileSync(bridgeEndpointPath(), "utf8"));
				if (file?.port === undefined) return undefined;
				baseUrl = `http://127.0.0.1:${file.port}`;
				if (token === "" && typeof file.localToken === "string") token = file.localToken;
			} catch {
				return undefined;
			}
		}
		if (token === "" && typeof process.env.MOTRIX_BRIDGE_TOKEN === "string") token = process.env.MOTRIX_BRIDGE_TOKEN;
		if (token === "") return undefined;
		return { baseUrl, token };
	}

	/** 直接调 MDXP JSON-RPC（用于幂等 add 与存在性校验；CLI 不暴露 idempotencyKey）。 */
	async function bridgeCall(method, params, timeoutMs = 20000) {
		const info = bridgeEndpoint();
		if (info === undefined) throw new Error("motrix bridge endpoint/token unavailable");
		const response = await fetch(`${info.baseUrl}/mdxp`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${info.token}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			signal: AbortSignal.timeout(timeoutMs)
		});
		if (!response.ok) throw new Error(`motrix bridge HTTP ${response.status}`);
		const json = await response.json();
		if (json?.error) throw new Error(`motrix bridge ${method} failed: ${json.error.message ?? json.error.code}`);
		return json?.result;
	}

	/** 桥接不可用时返回 undefined，由调用方回落到 CLI。 */
	async function addViaBridge(params) {
		if (bridgeEndpoint() === undefined) return undefined;
		return bridgeCall("download/add", params);
	}

	/** 幂等命中可能返回已删除任务的幽灵 id：用列表确认它真实存在。 */
	async function bridgeTaskExists(taskId) {
		if (bridgeEndpoint() === undefined) return true;
		const list = await bridgeCall("task/list", { limit: 500 });
		return (list?.tasks ?? []).some((task) => task.id === taskId);
	}

	/** 桥接是否就绪：endpoint 可取且一次 task/list 能成功。 */
	async function bridgeReady(timeoutMs) {
		try {
			await bridgeCall("task/list", { limit: 1 }, timeoutMs);
			return true;
		} catch {
			return false;
		}
	}

	/** 等待桥接就绪（静默拉起后最多等 config.openTimeoutMs）。 */
	async function waitForBridge(timeoutMs, signal) {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		for (;;) {
			if (signal?.aborted) throw abortError(signal);
			const remaining = deadline - Date.now();
			if (await bridgeReady(Math.max(250, Math.min(1500, remaining)))) return true;
			if (Date.now() >= deadline) return false;
			await delay(250, signal);
		}
	}

	/** 以隐藏窗口方式拉起桌面应用并等待桥接；找不到主程序返回 false（调用方回退 CLI open）。 */
	async function launchDesktopHidden(opts = {}) {
		if (disposed) return false;
		const exe = resolveMotrixExe(config);
		if (exe === undefined) return false;
		try {
			const child = spawn(exe, [...HIDDEN_LAUNCH_ARGS], { windowsHide: true, detached: true, stdio: "ignore" });
			child.on("error", () => {});
			child.unref();
		} catch {
			return false;
		}
		await waitForBridge(config.openTimeoutMs, opts.signal).catch(() => false);
		return true;
	}

	/** 启动一个长驻 CLI 流（用于 `motrix watch --json`）：按行回调，返回 { alive, close }。
	 * 与 run() 不同，它不等待退出；调用方负责在退出时 close。 */
	async function openStream(args, opts = {}) {
		// 与 run() 对齐：#241 的闭锁必须同样生效，否则插件卸载后仍能拉起长驻 `motrix watch`，
		// 而 dispose() 已经清空 activeChildren —— 那个子进程再也没人杀，成为孤儿。
		if (disposed) {
			const err = new Error("tool-motrix runner has been disposed (plugin unloaded); no further CLI processes will be spawned");
			err.code = "MOTRIX_RUNNER_DISPOSED";
			throw err;
		}
		const target = await resolveCommand();
		const fullArgs = [...target.prefixArgs, ...args];
		if (config.endpoint !== "") fullArgs.push("--endpoint", config.endpoint);
		const extraEnv = { ...target.extraEnv };
		if (config.token !== "") extraEnv.MOTRIX_BRIDGE_TOKEN = config.token;
		let child;
		try {
			child = spawn(target.command, fullArgs, {
				windowsHide: true,
				shell: target.shell,
				env: { ...process.env, ...extraEnv }
			});
		} catch (error) {
			resolved = undefined;
			throw error;
		}
		activeChildren.add(child);
		let alive = true;
		let buffer = "";
		const cleanup = () => {
			if (!alive) return;
			alive = false;
			activeChildren.delete(child);
			try {
				child.kill();
			} catch {}
		};
		const onAbort = () => cleanup();
		// 预中止：abort 事件早已派发时监听永不触发，子进程会成为孤儿。
		if (opts.signal?.aborted) cleanup();
		else opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.setEncoding("utf8").on("data", (chunk) => {
			buffer += chunk;
			let index;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (line === "") continue;
				try {
					opts.onLine?.(line);
				} catch {}
			}
		});
		child.on("error", () => {
			alive = false;
			activeChildren.delete(child);
			opts.signal?.removeEventListener("abort", onAbort);
		});
		child.on("close", () => {
			alive = false;
			activeChildren.delete(child);
			opts.signal?.removeEventListener("abort", onAbort);
		});
		return {
			get alive() {
				return alive;
			},
			close: cleanup
		};
	}

	/** 插件卸载时终止全部尚在运行的 CLI 子进程（由 apply 里的 ctx.effect 调用）。 */
	function dispose() {
		disposed = true; // codereview #241：先置闭锁再杀存量，杜绝 kill 后的再拉起
		for (const child of activeChildren) {
			try {
				child.kill();
			} catch {}
		}
		activeChildren.clear();
	}

	return { call, callJson, openStream, addViaBridge, bridgeTaskExists, dispose };
}

export { cliFailure, createRunner, EXIT_CODES };
