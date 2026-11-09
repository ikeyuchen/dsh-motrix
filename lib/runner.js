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
		// R9：记录是否撞上输出上限——被截断的 JSON 不能静默当成"空数据"（见 callJson）。
		let truncated = false;
		const append = (current, chunk) => {
			if (current.length >= cap) {
				truncated = true;
				return current;
			}
			if (current.length + chunk.length <= cap) return current + chunk;
			truncated = true;
			return (current + chunk).slice(0, cap);
		};
		child.stdout?.setEncoding("utf8").on("data", (chunk) => {
			stdout = append(stdout, chunk);
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk) => {
			stderr = append(stderr, chunk);
		});
		let settled = false;
		let timer;
		let forceSettleTimer;
		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer);
			// R6：强制收尾定时器同样要在收尾时清掉，避免超时路径把定时器泄漏到进程退出。
			if (forceSettleTimer !== undefined) clearTimeout(forceSettleTimer);
			opts.track?.delete(child);
			opts.signal?.removeEventListener("abort", onAbort);
		};
		// R6：settled 标志保证 close 迟到时不会二次 settle（Promise 已决议后 reject 会被吞成
		// unhandledRejection 噪音），同时统一在收尾时清理定时器与 track 登记。
		const settle = (finish) => {
			if (settled) return;
			settled = true;
			cleanup();
			finish();
		};
		// R6：kill 不保证子进程响应（僵死/挂起时 close 永不来）——超时或中止触发 kill 后若
		// 2s 内仍无 close，就强制收尾（超时按 timedOut 结果返回；中止按取消原因 reject）。
		const armForceSettle = () => {
			if (forceSettleTimer !== undefined) return;
			forceSettleTimer = setTimeout(() => {
				if (opts.signal?.aborted) {
					settle(() => reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("操作已被取消")));
					return;
				}
				settle(() => resolve({ code: -1, stdout, stderr, timedOut, truncated, maxOutput: cap, command, args }));
			}, 2000);
		};
		const onAbort = () => {
			child.kill();
			armForceSettle();
		};
		if (opts.timeoutMs !== undefined) {
			timer = setTimeout(() => {
				timedOut = true;
				child.kill();
				armForceSettle();
			}, opts.timeoutMs);
		}
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (error) => settle(() => reject(error)));
		child.on("close", (code) => {
			settle(() => {
				// codereview #242：中止被 kill 后 close 以 code null 回来——若仍 resolve 成 code:-1，
				// 调用方（与 cliFailure）无法区分"用户取消"与"CLI 崩溃"，会报出误导性的 exit -1；
				// 取消一律按取消原因 reject
				if (opts.signal?.aborted) {
					reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("操作已被取消"));
					return;
				}
				resolve({ code: code ?? -1, stdout, stderr, timedOut, truncated, maxOutput: cap, command, args });
			});
		});
	});
}

/** 从末尾向前做括号配平，提取结尾处那个完整的 JSON 值；字符串内的括号与转义引号跳过。 */
function extractTrailingJson(text) {
	const isEscaped = (index) => {
		let backslashes = 0;
		for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) backslashes += 1;
		return backslashes % 2 === 1;
	};
	let end = text.length - 1;
	while (end >= 0 && /\s/.test(text[end])) end -= 1;
	if (end < 0 || (text[end] !== "}" && text[end] !== "]")) return undefined;
	const stack = [];
	let inString = false;
	for (let i = end; i >= 0; i--) {
		const char = text[i];
		if (inString) {
			if (char === '"' && !isEscaped(i)) inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "}" || char === "]") {
			stack.push(char);
			continue;
		}
		if (char !== "{" && char !== "[") continue;
		const expected = char === "{" ? "}" : "]";
		if (stack.pop() !== expected) return undefined;
		if (stack.length === 0) {
			try {
				return JSON.parse(text.slice(i, end + 1));
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

/** 解析 CLI 的 JSON 输出；容忍前后混杂的非 JSON 行（含顶层数组）。 */
function parseCliJson(text) {
	const trimmed = String(text ?? "").trim();
	if (trimmed === "") return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {}
	// R8：CLI 可能先打一行 JSON 日志再打美化结果——从后往前逐行扫描会先命中日志对象。
	// 优先反向括号配平提取结尾那个完整 JSON 值，失败再退回逐行扫描与首尾跨度（保持旧兜底）。
	const trailing = extractTrailingJson(trimmed);
	if (trailing !== undefined) return trailing;
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

	/** 构造卸载闭锁错误（run/openStream 共用同一份文案与稳定 code）。 */
	function disposedError() {
		const err = new Error("tool-motrix runner has been disposed (plugin unloaded); no further CLI processes will be spawned");
		err.code = "MOTRIX_RUNNER_DISPOSED";
		return err;
	}

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
		if (disposed) throw disposedError();
		const target = await resolveCommand();
		// R1：resolveCommand 内部可能 await where.exe/node --version，卸载就发生在这段窗口里；
		// activeChildren 已被 dispose() 清空，此处再 spawn 就是无人可杀的孤儿——补一次闭锁检查。
		if (disposed) throw disposedError();
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
			// R7：宿主取消时 reject 的是 signal.reason（可能是普通 Error，name/code 都对不上），
			// 只看异常类型会误判成真实失败、把解析缓存清掉，下轮白跑 where.exe + node --version；
			// 以 opts.signal.aborted 为准判定取消。
			const isAbort =
				opts.signal?.aborted === true ||
				error?.name === "AbortError" ||
				error?.code === "ABORT_ERR" ||
				error?.code === "MOTRIX_RUNNER_DISPOSED";
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
		// R9：撞上输出上限时 stdout 是半截 JSON，parseCliJson 只会得到 undefined，调用方会
		// 误读成"没有数据"；这里响亮失败并给出收窄查询的指引。
		if (result.truncated) {
			const where = opts.context ? ` (${opts.context})` : "";
			throw new Error(
				`motrix CLI output exceeded the ${result.maxOutput ?? 8_000_000}-byte capture limit and was truncated${where}; ` +
					`narrow the query (e.g. a smaller --limit) and retry`
			);
		}
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

	/** 直接调 MDXP JSON-RPC（用于幂等 add 与存在性校验；CLI 不暴露 idempotencyKey）。
	 * R2：只挂 AbortSignal.timeout 会让桥接调用无视调用方取消（长超时下取消后仍占着请求）；
	 * 用 AbortSignal.any 把超时与调用方 signal 合并，signal 可选。 */
	async function bridgeCall(method, params, timeoutMs = 20000, signal) {
		const info = bridgeEndpoint();
		if (info === undefined) throw new Error("motrix bridge endpoint/token unavailable");
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const response = await fetch(`${info.baseUrl}/mdxp`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${info.token}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			signal: signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, signal])
		});
		if (!response.ok) throw new Error(`motrix bridge HTTP ${response.status}`);
		const json = await response.json();
		if (json?.error) throw new Error(`motrix bridge ${method} failed: ${json.error.message ?? json.error.code}`);
		return json?.result;
	}

	/** 桥接不可用时返回 undefined，由调用方回落到 CLI。 */
	async function addViaBridge(params, signal) {
		if (bridgeEndpoint() === undefined) return undefined;
		return bridgeCall("download/add", params, undefined, signal);
	}

	/** 幂等命中可能返回已删除任务的幽灵 id：用列表确认它真实存在。 */
	async function bridgeTaskExists(taskId, signal) {
		if (bridgeEndpoint() === undefined) return true;
		const limit = 500;
		const list = await bridgeCall("task/list", { limit }, undefined, signal);
		const tasks = list?.tasks ?? [];
		if (tasks.some((task) => task.id === taskId)) return true;
		// R4：列表只取一页 500 条——任务总数超过本页时"没找到"不等于"不存在"，否则新任务被
		// 挤出窗口就会 exists=false，tools.js 换随机 key 重复下载。窗口不全时按存在处理（
		// 宁可留一个幽灵 id 交给后续 manage 报错，也不重复建任务）；只有窗口完整才敢返回 false。
		// total 缺失/非数字时按页是否取满推断（取满说明可能还有下一页）。
		const total = Number.isFinite(list?.total) ? list.total : Number.NaN;
		const windowComplete = Number.isFinite(total) ? total <= tasks.length : tasks.length < limit;
		return !windowComplete;
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

	/** 以隐藏窗口方式拉起桌面应用并等待桥接；找不到主程序/拉起失败返回 false（调用方回退 CLI open）。 */
	async function launchDesktopHidden(opts = {}) {
		if (disposed) return false;
		const exe = resolveMotrixExe(config);
		if (exe === undefined) return false;
		let spawnFailed = false;
		try {
			const child = spawn(exe, [...HIDDEN_LAUNCH_ARGS], { windowsHide: true, detached: true, stdio: "ignore" });
			// R3：主程序起不来（ENOENT/EACCES 等）时 error 是异步抛的，吞掉后原来一律 return true，
			// 调用方就跳过 `motrix open` 回退；这里记下失败，与桥接等待结果一起判定。
			child.on("error", () => {
				spawnFailed = true;
			});
			child.unref();
		} catch {
			return false;
		}
		// R3：桥接没就绪同样视为没拉起来（原来丢弃了返回值恒 true），交给调用方回退 CLI open。
		const ready = await waitForBridge(config.openTimeoutMs, opts.signal).catch(() => false);
		return ready && !spawnFailed;
	}

	/** 启动一个长驻 CLI 流（用于 `motrix watch --json`）：按行回调，返回 { alive, close }。
	 * 与 run() 不同，它不等待退出；调用方负责在退出时 close。 */
	async function openStream(args, opts = {}) {
		// 与 run() 对齐：#241 的闭锁必须同样生效，否则插件卸载后仍能拉起长驻 `motrix watch`，
		// 而 dispose() 已经清空 activeChildren —— 那个子进程再也没人杀，成为孤儿。
		if (disposed) throw disposedError();
		const target = await resolveCommand();
		// R1：长驻 watch 同样要补闭锁——resolveCommand 的 await 期间可能已卸载，此时 spawn
		// 出来的 watch 不在 activeChildren 里（已被 dispose 清空），没有任何人能杀它。
		if (disposed) throw disposedError();
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
		// R5：watch 的 stderr 没有消费者时，子进程写满管道缓冲区会阻塞、watch 静默死掉而
		// alive 仍是 true；这里直接丢弃 stderr（诊断价值低，不阻塞才是关键）。
		child.stderr?.resume();
		let alive = true;
		let buffer = "";
		let discarding = false;
		const maxBuffer = 1024 * 1024;
		const cleanup = () => {
			if (!alive) return;
			alive = false;
			activeChildren.delete(child);
			// R5：收尾时移除 abort 监听，避免长寿命 signal 上堆积常驻监听器。
			opts.signal?.removeEventListener("abort", onAbort);
			try {
				child.kill();
			} catch {}
		};
		const onAbort = () => cleanup();
		// 预中止：abort 事件早已派发时监听永不触发，子进程会成为孤儿。
		if (opts.signal?.aborted) cleanup();
		else opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.setEncoding("utf8").on("data", (chunk) => {
			// R5：上一块已因超长被丢弃时，继续丢到下一个换行为止——否则残尾会被当成
			// 一条"半行"回调出去（极端情况下可能恰好是合法 JSON，被误读成事件）。
			if (discarding) {
				const newline = chunk.indexOf("\n");
				if (newline < 0) return;
				chunk = chunk.slice(newline + 1);
				discarding = false;
			}
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
			// R5：超长无换行行会让 buffer 无界增长；完整行已在上面消费完，超限时丢掉
			// 尚未成行的半截数据并进入丢弃模式，换取内存上限。
			if (buffer.length > maxBuffer) {
				buffer = "";
				discarding = true;
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
