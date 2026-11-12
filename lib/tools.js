/**
 * dsh-motrix / lib/tools.js
 * ================================
 * 一个模型可见网关工具 motrix（action = download | tasks | manage）的注册体及其私有辅助：
 * motrix 网关（action = download | tasks | manage）。CLI 子进程管理层在 ./runner.js。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertSafeHeader, checkFileForDelete, noteTasks, stageOf, staleOf, verifyTask } from "./inspect.js";
import { cliFailure, EXIT_CODES } from "./runner.js";

/** motrix CLI 任务状态的完整枚举（来自 `motrix list --status` 的校验错误信息）。 */
const TASK_STATUSES = [
	"queued",
	"fetching_metadata",
	"downloading",
	"paused",
	"seeding",
	"finalizing",
	"completed",
	"error"
];
/** 等待循环中视为「已落定」的状态：seeding 表示 BT 下载已完成、仅在上传。 */
const SETTLED_STATUSES = new Set(["completed", "seeding", "paused", "error"]);
/** codereview #449：CLI list 的取数窗口（fetch window）。list 按「旧→新」排序且 limit
 * 截断头部，轮询追踪与 action=tasks 都必须取足够大的窗口，否则新任务不在返回集里
 * （曾导致完成信号丢失）。两处共用同一常量——此前 500 各写一份，改一处漏一处。 */
const LIST_FETCH_WINDOW = 500;

/** 可中止的 sleep。 */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(done, ms);
		function done() {
			cleanup();
			resolve();
		}
		function onAbort() {
			cleanup();
			reject(new Error("aborted"));
		}
		function cleanup() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function fmtBytes(value) {
	if (value === null || value === undefined || !Number.isFinite(value)) return "?";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let size = value;
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit += 1;
	}
	let rounded = size >= 100 || unit === 0 ? Math.round(size) : Math.round(size * 10) / 10;
	// 取整可能把 1023.x 拉成 1024：补一次进位，避免出现 "1024 KB" 这种读数。
	if (rounded >= 1024 && unit < units.length - 1) {
		rounded = 1;
		unit += 1;
	}
	return `${rounded} ${units[unit]}`;
}

function fmtEta(seconds) {
	if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";
	const total = Math.round(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
	return `${s}s`;
}

function truncate(text, max) {
	const value = String(text);
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** 压平换行：任务名/路径/错误来自远端，含 \n 时会伪造出额外的模型可见行。 */
function oneLine(value) {
	return String(value ?? "").replace(/[\r\n]+/g, " ");
}

/** 审查修复 #54：argv 注入防护——凡拼进 CLI argv 的调用方可控值禁止以 "-" 开头
 *  （否则会被 motrix CLI 当作选项解析、吞掉后续 token、静默改变行为）。 */
function assertSafeCliValue(value, label) {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
	if (value.startsWith("-")) throw new Error(`${label} must not start with "-" (would be parsed as a CLI option): ${truncate(value, 40)}`);
	return value;
}

/** 跨平台绝对路径：`C:\…` / `C:/…` / `\\server\share` 与 POSIX `/…` 都算（endpoint 指向远端时是服务端路径）。 */
function isPortableAbsolute(value) {
	return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value);
}

/** filename 只能是纯文件名：CLI/aria2 不接受路径分隔符，`../x` 也不能借桥接写出 saveDir。 */
function assertSafeFilename(value) {
	assertSafeCliValue(value, "filename");
	if (value === "." || value === ".." || /[\\/\0]/.test(value)) {
		throw new Error(`filename must be a plain file name (no path separators or ".."): ${truncate(value, 60)}`);
	}
	return value;
}

/** 幂等键归一化：同一目录的不同写法（尾斜杠/反斜杠）不应派生不同 key。 */
function normalizeForIdempotency(value) {
	return String(value ?? "")
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/\/+$/, "");
}

/** 请求头归一化：名称小写、值去空白、排序后进幂等键（顺序/大小写不同不应重复建任务）。 */
function normalizeHeadersForIdempotency(headers) {
	return (headers ?? [])
		.map((header) => {
			const index = String(header).indexOf(":");
			if (index < 0) return String(header).trim().toLowerCase();
			return `${String(header).slice(0, index).trim().toLowerCase()}:${String(header).slice(index + 1).trim()}`;
		})
		.sort();
}

/** 代理 URL 白名单校验：只允许 aria2 支持的 http(s)/socks5(h)/socks4，且必须带 host[:port]。
 *  此前 proxy 既不在 schema 也不进 argv/桥接参数：调用方传了也被静默丢弃（真功能 bug），
 *  非法值（如 file:///etc/passwd）还会一路走到 add 才发现没生效。 */
const PROXY_SCHEMES = /^(?:https?|socks5h?|socks4):\/\//i;
function assertProxyUrl(value) {
	if (typeof value !== "string" || value.trim() === "") throw new Error("proxy must be a non-empty URL string");
	const trimmed = value.trim();
	if (!PROXY_SCHEMES.test(trimmed)) {
		throw new Error(`proxy must start with http://, https://, socks5://, socks5h:// or socks4://: ${truncate(trimmed, 40)}`);
	}
	let parsed;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`proxy is not a valid URL: ${truncate(trimmed, 40)}`);
	}
	if (parsed.hostname === "") throw new Error(`proxy must include a host[:port]: ${truncate(trimmed, 40)}`);
	return assertSafeCliValue(trimmed, "proxy");
}

/** 把 CLI 任务对象投影成紧凑输出（绝不携带 bt.trackers 之类的大数组）。 */
function projectTask(task) {
	const out = {
		id: task.id,
		name: task.name,
		type: task.type,
		status: task.status
	};
	if (typeof task.progress === "number") out.progress = Math.round(task.progress * 1000) / 1000;
	if (task.bytesDone) out.bytesDone = task.bytesDone;
	if (task.bytesTotal) out.bytesTotal = task.bytesTotal;
	if (task.speedBps) out.speedBps = task.speedBps;
	if (task.etaSec !== null && task.etaSec !== undefined) out.etaSec = task.etaSec;
	if (task.saveDir) out.saveDir = task.saveDir;
	if (task.finalPath) out.finalPath = task.finalPath;
	if (task.error) out.error = truncate(String(task.error).trim(), 300);
	// 失败诊断：CLI 本来就返回 errorCode（此前被投影丢弃），补回去并给出可处置的 stage。
	if (task.errorCode) out.errorCode = String(task.errorCode);
	const stage = task.errorCode || task.error ? stageOf(task.errorCode, task.error) : undefined;
	if (stage !== undefined) out.stage = stage;
	if (task.bt !== null && typeof task.bt === "object") {
		out.bt = { peers: task.bt.peers, seeds: task.bt.seeds, ratio: task.bt.ratio };
	}
	return out;
}

/** 模型可读的单行任务摘要（必须携带 id，供后续 action=manage 引用）。 */
function renderTaskLine(task) {
	const progress = typeof task.progress === "number" ? `${Math.round(task.progress * 1000) / 10}%` : "?";
	const size = `${fmtBytes(task.bytesDone)}/${fmtBytes(task.bytesTotal)}`;
	const parts = [`- ${oneLine(task.name)} [${task.status}]`, progress, size];
	if (task.speedBps) parts.push(`${fmtBytes(task.speedBps)}/s`);
	const eta = fmtEta(task.etaSec);
	if (eta !== "") parts.push(`ETA ${eta}`);
	const line = parts.join(" ");
	// 单行契约：name/finalPath/error 都可能来自远端，必须压平换行，避免伪造额外任务行。
	let suffix = "";
	if (task.finalPath) suffix = ` → ${oneLine(task.finalPath)}`;
	// finalPath 与 error 同时存在时两者都要给：只显示路径会让失败原因在模型可见通道里消失。
	if (task.error !== undefined) suffix += ` (${task.stage ?? "error"}: ${oneLine(task.error)})`;
	// render 是模型可见通道：校验结果必须进文本，只落 output 对象模型看不到。
	if (task.verification?.ok === true) suffix += " [sha256 ok]";
	else if (task.verification?.ok === false) suffix += ` [verify: ${task.verification.reason}]`;
	if (task.stale === true) suffix += " [stale]";
	if (task.source !== undefined) suffix += ` [src: ${task.source}]`;
	return `${line}${suffix} [id: ${task.id}]`;
}

function formatDownloadOutput(value) {
	const lines = [];
	const headline = value.settled === true ? "settled" : "in progress";
	lines.push(`Motrix: ${value.added} task(s), ${headline}.`);
	for (const task of value.tasks ?? []) lines.push(renderTaskLine(task));
	if (value.hint !== undefined) lines.push(value.hint);
	return lines.join("\n");
}

function formatTasksOutput(value) {
	const lines = [];
	lines.push(`Motrix tasks: showing ${value.count} of ${value.total}.`);
	if (value.stats !== undefined) {
		lines.push(
			`Stats: ↓${fmtBytes(value.stats.downloadSpeedBps)}/s ↑${fmtBytes(value.stats.uploadSpeedBps)}/s, ` +
				`active ${value.stats.activeTasks}, waiting ${value.stats.waitingTasks}, stopped ${value.stats.stoppedTasks}.`
		);
	}
	for (const task of value.tasks ?? []) lines.push(renderTaskLine(task));
	return lines.join("\n");
}

/** 投影任务并附上校验结果与失败来源（source 只在失败/校验不通过时携带，省上下文）。 */
async function buildDownloadTasks(tasks, settled, sourceById, expectedSha256, signal) {
	return Promise.all(
		tasks.map(async (task) => {
			const out = projectTask(task);
			if (settled) {
				try {
					const verification = await verifyTask(task, expectedSha256, signal);
					if (verification !== undefined) out.verification = verification;
				} catch (error) {
					// 取消要上抛；其它校验异常降级成字段，不能把已完成的下载判成整次失败。
					if (signal?.aborted) throw error;
					out.verification = { ok: false, reason: "verify-error" };
				}
			}
			const failed = task.status === "error" || task.status === "paused" || out.verification?.ok === false;
			if (failed && sourceById.has(task.id)) out.source = sourceById.get(task.id);
			return out;
		})
	);
}

/** 注册 motrix 网关（action = download | tasks | manage）；deps.runner 是 apply 里创建并经 ctx.effect 声明清理的 CLI 调用器。 */
function registerMotrixTools(ctx, config, deps) {
	const runner = deps.runner;
	/* --------------------- runDownload --------------------- */
	async function runDownload(args, exec) {
		if (args.run_in_background === true) {
			const jobs = ctx?.get?.("jobs");
			if (jobs === null || jobs === undefined || typeof jobs.start !== "function") {
				throw new Error("run_in_background needs the jobs runtime: load dsh-jobs-local + dsh-tool-jobs, or drop the flag");
			}
			const label = `motrix download ${args.urls?.length ?? 0} URL(s) -> ${args.saveDir ?? "?"}`;
			const controller = new AbortController();
			let cancelReason = null;
			const jobId = jobs.start({
				kind: "motrix",
				label,
				owner: exec?.agent?.id ?? exec?.agent?.session?.id,
				...(typeof exec?.callId === "string"
					? { toolCall: { callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId } } : {}),
				run(handle) {
					const done = (async () => {
						try {
							const result = await runDownload({ ...args, run_in_background: false }, {
								...exec,
								// 后台任务应独立于外层调用存活：只跟 job 自己的取消信号，不合并 exec.signal
								// （宿主在外层调用收尾时 abort exec.signal，会把后台任务无差别杀掉）。
								signal: controller.signal
							});
							const serialized = JSON.stringify(result);
							handle.append(serialized);
							return { status: "completed", result: serialized };
						} catch (error) {
							return {
								status: cancelReason !== null ? "killed" : "failed",
								detail: cancelReason !== null ? cancelReason : String(error?.message ?? error)
							};
						}
					})();
					return {
						cancel(reason) {
							cancelReason = typeof reason === "string" && reason !== "" ? reason : "cancelled";
							controller.abort(cancelReason);
						},
						done,
					};
				},
			});
			return { kind: "background", jobId: String(jobId), label };
		}
		// 重复 URL 没有意义：先去重再校验/建任务，added 才不会虚报，也不会白跑一次 add。
		const urls = [...new Set(args.urls ?? [])];
		const magnets = urls.filter((url) => /^magnet:/i.test(url));
		const httpUrls = urls.filter((url) => !/^magnet:/i.test(url));
		if (urls.length === 0 && args.torrentFile === undefined) throw new Error("urls must contain at least one URL, or pass torrentFile");
		if (urls.length > config.maxUrlsPerCall) throw new Error(`urls must contain at most ${config.maxUrlsPerCall} URLs`);
		if (args.torrentFile !== undefined && urls.length > 0) throw new Error("torrentFile is exclusive with urls");
		// 不兼容组合响亮失败：这些旗标在磁力/种子分支或 http 分支会被静默丢弃（项目口径：不改写调用方意图）。
		const usesBt = magnets.length > 0 || args.torrentFile !== undefined;
		const usesHttp = httpUrls.length > 0;
		if (args.filename !== undefined && (usesBt || httpUrls.length > 1)) {
			throw new Error("filename is only valid with a single http/ftp url (BT names come from the torrent)");
		}
		if (args.select !== undefined && usesHttp) throw new Error("select is only valid with magnet/torrentFile");
		for (const key of ["connections", "headers", "proxy"]) {
			if (args[key] !== undefined && usesBt) throw new Error(`${key} is only valid with http/ftp urls`);
		}
		if (typeof args.saveDir !== "string" || args.saveDir.trim() === "") throw new Error("saveDir must be a non-empty absolute directory path");
		// 响亮失败而不是让 CLI 把相对路径按宿主 cwd 解析（文件会落到意料之外的目录）。
		if (!isPortableAbsolute(args.saveDir.trim())) throw new Error(`saveDir must be an absolute path (got ${JSON.stringify(args.saveDir)})`);
		// 代理只在 url 模式生效（桥接 download/add 的 url 分支才有 proxy 字段）；非法 scheme 响亮失败。
		const proxy = args.proxy === undefined ? undefined : assertProxyUrl(args.proxy);
		// 越界不再静默 clamp：与「不改写调用方意图、非法值响亮失败」口径一致。
		const connections = (() => {
			if (args.connections === undefined) return undefined;
			const value = Number(args.connections);
			if (!Number.isInteger(value) || value < 1 || value > 64) {
				throw new Error(`connections must be an integer between 1 and 64 (got ${JSON.stringify(args.connections)})`);
			}
			return value;
		})();
		// 桥接 add 用的参数（与 CLI 分支同源；headers 拆成 {name,value}）。
		const headerObjects = (args.headers ?? []).map((header) => {
			const index = header.indexOf(":");
			return { name: header.slice(0, index).trim(), value: header.slice(index + 1).trim() };
		});
		// select 严格按十进制整数解析：parseInt("0x", 10) 会静默当成 0，桥接/CLI 两条路径必须同义。
		let selectExpr;
		let selectIndices;
		if (args.select !== undefined) {
			selectIndices = args.select.split(",").map((part) => {
				const text = part.trim();
				if (!/^\d+$/.test(text)) throw new Error('select must be comma-separated non-negative integers, e.g. "0,2"');
				return Number(text);
			});
			selectExpr = selectIndices.join(",");
		}
		// 幂等键：同一（源 + 目录 + 改名 + 选择 + 头）派生稳定 key，模型超时重试不会建重复任务；
		// 目录尾斜杠/反斜杠、header 顺序与大小写等语义等价写法要先归一化，否则重试仍会重复下载。
		const normalizedSaveDir = normalizeForIdempotency(args.saveDir);
		const normalizedHeaders = normalizeHeadersForIdempotency(args.headers);
		const idempotencyKeyFor = (source) =>
			createHash("sha256")
				.update(
					JSON.stringify({
						source,
						saveDir: normalizedSaveDir,
						filename: args.filename,
						select: selectExpr,
						headers: normalizedHeaders,
						connections,
						proxy
					})
				)
				.digest("hex")
				.slice(0, 32);
		// 审查修复 #54：全部调用方可控值过校验后才拼进 CLI argv；URL 另按文档口径
		//（http(s)/ftp/magnet 方案白名单）校验，防止 "-x" 这类值被 CLI 当成选项。
		for (const [index, url] of urls.entries()) {
			assertSafeCliValue(url, `urls[${index}]`);
			if (!/^(?:https?|ftp|magnet):/i.test(url)) throw new Error(`urls[${index}] must be an http(s)://, ftp://, or magnet: URI`);
		}
		assertSafeCliValue(args.saveDir, "saveDir");
		if (args.filename !== undefined) assertSafeFilename(args.filename);
		for (const [index, header] of (args.headers ?? []).entries()) {
			assertSafeCliValue(header, `headers[${index}]`);
			assertSafeHeader(header, `headers[${index}]`);
		}
		if (args.select !== undefined) assertSafeCliValue(args.select, "select");
		if (args.torrentFile !== undefined) assertSafeCliValue(args.torrentFile, "torrentFile");
		if (args.sha256 !== undefined) {
			// schema 表达不了「64 位十六进制」，非法值在此响亮失败（不静默忽略校验请求）。
			if (typeof args.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(args.sha256)) {
				throw new Error("sha256 must be a 64-character hexadecimal SHA-256 digest");
			}
			const sourceCount = urls.length + (args.torrentFile === undefined ? 0 : 1);
			if (sourceCount !== 1) {
				throw new Error("sha256 requires exactly one download source (one URL, one magnet, or one torrentFile)");
			}
			// 校验只在订单落定时发生：wait:false 下会静默丢掉校验请求，必须响亮失败。
			if (args.wait === false) {
				throw new Error("sha256 requires waiting for completion (wait:false cannot verify); drop sha256 or leave wait unset");
			}
		}

		const created = [];
		// 任务 id → 请求源（URL/磁力/种子）：只在任务失败或校验不通过时回显，避免常态增 token。
		const sourceById = new Map();
		// 逐个源收集失败：一个坏源不能吃掉其余 URL（此前任一 add 抛错会整体上抛，
		// 已建任务连同 created 一起丢失，且后面的源根本不再尝试）。
		const failures = [];
		const recordFailure = (source, error) => failures.push({ source, error });
		const failureHint = () =>
			failures.length === 0
				? ""
				: `${failures.length} source(s) failed and were skipped: ${failures
						.map(({ source, error }) => `${truncate(source, 80)} — ${truncate(String(error?.message ?? error), 160)}`)
						.join("; ")}.`;
		const addOptions = { timeoutMs: config.addTimeoutMs, signal: exec.signal, context: "add" };
		// codereview #450：http/磁力/种子三个 add 分支共用同一收尾——补 --json、执行、
		// 收集创建的任务对象；后续加旗标或校验只改这一处，不再三份漂移
		const addTasks = async (argv, source, bridgeParamsFactory) => {
			// 幂等优先：桥接层原生支持 idempotencyKey（CLI 不暴露）；不可用时回落 CLI。
			if (config.idempotent !== false) {
				let params;
				try {
					params = { ...(await bridgeParamsFactory()), idempotencyKey: idempotencyKeyFor(source) };
				} catch {
					params = undefined; // 参数构造失败（如种子文件读不到）→ 交给 CLI 报错
				}
				if (params !== undefined) {
					let task;
					try {
						task = await runner.addViaBridge(params, exec.signal);
					} catch {
						// 同 key 重试一次（幂等）；仍失败才回落 CLI，避免误建重复任务。
						try {
							task = await runner.addViaBridge(params, exec.signal);
						} catch {
							task = undefined;
						}
					}
					if (task !== undefined && task.id !== undefined) {
						let exists = true;
						try {
							exists = await runner.bridgeTaskExists(task.id, exec.signal);
						} catch {
							exists = true; // 存在性查询失败不能触发 CLI 回落（会重复建任务）
						}
						if (!exists) {
							// 列表可能有延迟：再确认一次；仍不存在才换随机 key。
							await new Promise((resolve) => setTimeout(resolve, 300));
							try {
								exists = await runner.bridgeTaskExists(task.id, exec.signal);
							} catch {
								exists = true;
							}
						}
						if (!exists) {
							// 指纹命中但任务已被删除（桥接层会返回幽灵 id）：换随机 key 重试；
							// 这里失败必须上抛——回落 CLI 会重建重复任务。
							task = await runner.addViaBridge({ ...params, idempotencyKey: randomUUID() }, exec.signal);
						}
						if (task !== undefined && task.id !== undefined) {
							created.push(task);
							sourceById.set(task.id, source);
							return;
						}
					}
				}
			}
			argv.push("--json");
			const task = await runner.callJson(argv, addOptions);
			if (task !== undefined) {
				created.push(task);
				if (task.id !== undefined) sourceById.set(task.id, source);
			}
		};
		// 2026-10-11 修复：CLI `add u1 u2` 是「一个任务多镜像 URI」语义（bridge API 的
		// uris 数组），不是 N 个任务——一次塞多个 URL 只有第一个文件会被下载（当晚实测
		// 8 URL 只建 1 任务）。http 分支改为逐 URL 调 CLI，与下方磁力链分支同构；
		// filename 在入口已限单 http URL，循环内携带安全。
		for (const url of httpUrls) {
			const argv = ["add", url, "--save-dir", args.saveDir];
			if (args.filename !== undefined) argv.push("--filename", args.filename);
			for (const header of args.headers ?? []) argv.push("--header", header);
			if (connections !== undefined) argv.push("--connections", String(connections));
			if (proxy !== undefined) argv.push("--proxy", proxy);
			try {
				await addTasks(argv, url, () => ({
					kind: "url",
					saveDir: args.saveDir,
					uris: [url],
					...(args.filename !== undefined ? { filename: args.filename } : {}),
					...(headerObjects.length > 0 ? { headers: headerObjects } : {}),
					...(connections !== undefined ? { connections } : {}),
					...(proxy !== undefined ? { proxy } : {})
				}));
			} catch (error) {
				recordFailure(url, error);
			}
		}
		for (const magnet of magnets) {
			const argv = ["add", "--magnet", magnet, "--save-dir", args.saveDir];
			if (selectExpr !== undefined) argv.push("--select", selectExpr);
			try {
				await addTasks(argv, magnet, () => ({
					kind: "magnet",
					saveDir: args.saveDir,
					uri: magnet,
					...(selectIndices !== undefined ? { selectedFiles: selectIndices } : {})
				}));
			} catch (error) {
				recordFailure(magnet, error);
			}
		}
		if (args.torrentFile !== undefined) {
			const argv = ["add", "--torrent", args.torrentFile, "--save-dir", args.saveDir];
			if (selectExpr !== undefined) argv.push("--select", selectExpr);
			try {
				await addTasks(argv, args.torrentFile, () => ({
					kind: "torrent",
					saveDir: args.saveDir,
					base64: readFileSync(args.torrentFile).toString("base64"),
					...(selectIndices !== undefined ? { selectedFiles: selectIndices } : {})
				}));
			} catch (error) {
				recordFailure(args.torrentFile, error);
			}
		}
		// 一个都没建出来才算整次失败；部分成功时继续等待并汇报失败的源。
		if (created.length === 0 && failures.length > 0) {
			const first = failures[0];
			const detail = String(first.error?.message ?? first.error);
			throw new Error(`${detail}${failures.length > 1 ? ` (and ${failures.length - 1} more source(s) failed)` : ""}`);
		}

		const ids = created.map((task) => task.id).filter((id) => id !== undefined);
		if (ids.length === 0) {
			return {
				added: created.length,
				settled: true,
				tasks: created.map(projectTask),
				hint:
					"The CLI accepted the task(s) but returned no task objects." +
					(args.sha256 !== undefined ? " sha256 was NOT verified (no task object to track)." : "") +
					(failures.length > 0 ? ` ${failureHint()}` : "")
			};
		}
		if (args.wait === false) {
			return {
				added: created.length,
				settled: false,
				tasks: created.map(projectTask),
				hint:
					"Queued in Motrix without waiting. Poll with motrix (action=tasks)." +
					(failures.length > 0 ? ` ${failureHint()}` : "")
			};
		}

		// codereview #448：等待预算的钳制修正——(1) 显式 waitTimeoutMs 是调用方意图，
		// 全额尊重（AGENTS §1.6 优先级：工具参数 > Config > 内置默认；旧 5000ms 地板会把
		// waitTimeoutMs=2000 悄悄改成 5000）；schema 表达不了正数约束，非法值在此响亮失败
		//（旧地板曾把 0/负数静默垫成 5000，同样属于「静默改写调用方意图」）；
		// (2) 工具超时余量（整体超时 - 30s 提交/轮询开销）只在为正时才作上限——旧写法
		// Math.min 先产出负值再被地板掩盖，预算与真实工具超时脱钩，宿主会在等待中途
		// 杀掉工具（AbortError 而非优雅的进度返回）。
		if (args.waitTimeoutMs !== undefined && (!Number.isFinite(args.waitTimeoutMs) || args.waitTimeoutMs <= 0)) {
			throw new Error(`waitTimeoutMs must be a positive number of milliseconds (got ${JSON.stringify(args.waitTimeoutMs)})`);
		}
		const capByToolTimeout = config.downloadToolTimeoutMs - 30000;
		let budget = args.waitTimeoutMs ?? config.defaultWaitTimeoutMs;
		if (capByToolTimeout > 0) budget = Math.min(budget, capByToolTimeout);
		const deadline = Date.now() + budget;
		// 停滞检测：字节数长时间不增长 → 提前返回而不是烧光预算（0 关闭）。
		const stallWindow = Math.max(0, config.stallWindowMs ?? 0);
		const progressWatch = new Map();
		// 窗口取 LIST_FETCH_WINDOW（见常量定义处的说明），轮询才能看到新建任务。
		const pollLimit = LIST_FETCH_WINDOW;
		const tracked = new Set(ids);
		const btRoots = new Map(created.filter((task) => task.type === "bt" && task.id !== undefined).map((task) => [task.id, task]));
		const normDir = (dir) => String(dir ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
		// 事件流（`motrix watch --json`）：事件到达立即唤醒，把轮询间隔放宽到 watchPollMs；
		// watch 启动失败/中途退出时自动退回 pollIntervalMs 普通轮询。事件很密集，需去抖。
		let wakeResolve = null;
		let lastSnapshotAt = 0;
		const wake = () => {
			const resolve = wakeResolve;
			wakeResolve = null;
			resolve?.();
		};
		const waitForWake = () => new Promise((resolve) => {
			wakeResolve = resolve;
		});
		// 懒启动：首次快照已落定的快下载不付 watch 进程启动成本。
		let watcher = null;
		let watchStarted = false;
		const startWatcher = async () => {
			watchStarted = true;
			try {
				watcher = await runner.openStream(["watch", "--json"], {
					signal: exec.signal,
					onLine(line) {
						try {
							const event = JSON.parse(line);
							if (
								typeof event?.event === "string" &&
								event.event.startsWith("$/task/") &&
								tracked.has(event.data?.taskId) &&
								Date.now() - lastSnapshotAt >= 1500
							) {
								wake();
							}
						} catch {}
					}
				});
			} catch {
				watcher = null;
			}
		};
		// 所有退出点都走这里，保证 watch 子进程被关闭。
		const finish = (value) => {
			watcher?.close();
			return value;
		};
		// codereview #249：tracked 全部不在 list 窗口里（被 >500 条更新任务挤出或被 CLI 清理）
		// 时不再烧光预算装作在等——连续 3 轮为空就提前退出，并明说返回的是 add 时刻快照
		let emptyPolls = 0;
		let firstPoll = true;
		// 等待期间的 list 是观测手段，不是下载本身：桥接抖动/CLI 重启/单次 timedOut 不能让
		// 整次调用报错（任务仍在 Motrix 里跑）。保留上一份快照继续等，连续 3 次才优雅收尾。
		let listFailures = 0;
		let lastTasks = null;
		for (;;) {
			if (!firstPoll) {
				const waitMs = watcher?.alive ? Math.max(config.pollIntervalMs, config.watchPollMs ?? 5000) : config.pollIntervalMs;
				await Promise.race([sleep(waitMs, exec.signal), waitForWake()]);
			}
			firstPoll = false;
			let list;
			try {
				list = await runner.callJson(
					["list", "--limit", String(pollLimit), "--json"],
					{ timeoutMs: config.cliTimeoutMs, signal: exec.signal, context: "list" }
				);
				listFailures = 0;
				lastTasks = list;
			} catch (error) {
				// 取消与插件卸载必须立刻上抛；其余失败按「观测中断」降级。
				if (exec.signal?.aborted || error?.code === "MOTRIX_RUNNER_DISPOSED") {
					watcher?.close();
					throw error;
				}
				listFailures += 1;
				if (listFailures >= 3) {
					const stale = lastTasks?.tasks ?? [];
					const watchedStale = stale.filter((task) => tracked.has(task.id));
					return finish({
						added: created.length,
						settled: false,
						tasks: (watchedStale.length > 0 ? watchedStale : created).map(projectTask),
						hint:
							`motrix list failed ${listFailures} times in a row (${String(error?.message ?? error)}); ` +
							"returning the last known snapshot. The download(s) may still be running in Motrix — " +
							"re-check with motrix (action=tasks)." +
							(args.sha256 !== undefined ? " sha256 was NOT verified (the download had not settled)." : "") +
							(failures.length > 0 ? ` ${failureHint()}` : "")
					});
				}
				list = lastTasks ?? { tasks: [] };
			}
			lastSnapshotAt = Date.now();
			const allTasks = list?.tasks ?? [];
			noteTasks(allTasks);
			// BT（磁力/种子）元数据任务完成后，Motrix 会以新任务 id 转入正式下载；
			// 把同 saveDir、更晚创建的 bt 任务纳入追踪，避免把「元数据完成」误判为「下载完成」。
			for (const task of allTasks.filter((task) => btRoots.has(task.id) && task.status === "completed")) {
				const root = btRoots.get(task.id);
				const rootHash = task.infoHash;
				for (const candidate of allTasks) {
					if (tracked.has(candidate.id) || candidate.type !== "bt") continue;
					// 同目录并发磁力：双方 infoHash 都已知且不同 → 不是同一颗种子，禁止收养。
					if (
						typeof rootHash === "string" &&
						rootHash !== "" &&
						typeof candidate.infoHash === "string" &&
						candidate.infoHash !== "" &&
						candidate.infoHash !== rootHash
					) {
						continue;
					}
					// 审查修复 #55：root 或 candidate 任一缺 createdAt 时不再收养（原 ?? 0 会把
					// 同目录里全部 bt 任务——含更早创建的——都当成新任务收养）；严格双方都有时
					// 间戳且 candidate 更晚，与 root 同 saveDir。
					if (
						root.createdAt !== undefined &&
						candidate.createdAt !== undefined &&
						candidate.createdAt > root.createdAt &&
						normDir(candidate.saveDir) === normDir(root.saveDir)
					) {
						tracked.add(candidate.id);
						// 收养的 BT 正式下载任务继承元数据根任务的请求源，失败时才能回显 source。
						if (!sourceById.has(candidate.id) && sourceById.has(root.id)) sourceById.set(candidate.id, sourceById.get(root.id));
					}
				}
			}
			const watched = allTasks.filter((task) => tracked.has(task.id));
			// 停滞：所有未落定任务都在下载但字节数超过阈值未变 → 提前返回（不烧完等待预算）。
			{
				const now = Date.now();
				for (const task of watched) {
					const prev = progressWatch.get(task.id);
					const bytes = typeof task.bytesDone === "number" ? task.bytesDone : 0;
					// 任何字节数变化都算「有活动」：任务重置/重下时 bytesDone 会回落，
					// 只认增长会把健康下载误判成停滞。
					if (prev === undefined || bytes !== prev.bytes) progressWatch.set(task.id, { bytes, at: now });
				}
				const unfinished = watched.filter((task) => !SETTLED_STATUSES.has(task.status));
				// 只对真正在下载的任务判停滞：并发上限把后面的排成 queued 时，
				// 有任务卡死也不该被 queued 兄弟拖到预算耗尽。
				const downloading = unfinished.filter((task) => task.status === "downloading");
				if (
					stallWindow > 0 &&
					watched.length > 0 &&
					downloading.length > 0 &&
					downloading.every((task) => now - (progressWatch.get(task.id)?.at ?? now) >= stallWindow)
				) {
					const stalledHints = [
						`No progress for ${Math.max(1, Math.round(stallWindow / 1000))}s on ${downloading.length} task(s) — likely stalled. Try another source, add headers, or re-add; the task(s) stay in Motrix (motrix action=tasks / action=manage).`
					];
					if (args.sha256 !== undefined) stalledHints.push("sha256 was NOT verified (the download had not settled).");
					if (failures.length > 0) stalledHints.push(failureHint());
					return finish({ added: created.length, settled: false, tasks: watched.map(projectTask), hint: stalledHints.join(" ") });
				}
			}
			if (watched.length === 0) {
				emptyPolls += 1;
				if (emptyPolls >= 3) {
					return finish({
						added: created.length,
						settled: false,
						tasks: created.map(projectTask),
						hint:
							"Tracked task(s) no longer appear in the task-list window (evicted by newer tasks or pruned by the CLI); returning the add-time snapshot, which may be stale. Re-check with motrix (action=tasks)." +
							(args.sha256 !== undefined ? " sha256 was NOT verified (the task never settled in this call)." : "") +
							(failures.length > 0 ? ` ${failureHint()}` : "")
					});
				}
			} else {
				emptyPolls = 0;
			}
			const settled = watched.length > 0 && watched.every((task) => SETTLED_STATUSES.has(task.status));
			// 没落定且启用 watch 时，此刻才付出事件流的启动成本。
			if (!settled && !watchStarted && config.useWatch !== false && Date.now() < deadline) await startWatcher();
			if (settled || Date.now() >= deadline) {
				const tasks = watched.length > 0 ? watched : created;
				// codereview #250：因 paused/error 落定时必须显式说明"未完成"——settled=true 单独
				// 出现会让模型误以为文件已下载完（暂停的任务用户随时可恢复继续传）
				const hints = [];
				// 部分任务被挤出 500 条窗口时，settled 只是幸存子集的结论，必须明说未观测到的数量。
				const unobserved = tracked.size - watched.length;
				if (unobserved > 0) {
					hints.push(`${unobserved} tracked task(s) fell out of the task-list window; their status is unobserved — re-check with motrix (action=tasks).`);
				}
				if (!settled) {
					hints.push(`Wait budget of ${budget} ms exhausted; the downloads keep running in Motrix. Poll again with motrix (action=tasks).`);
					// sha256 只在本次调用等到落定时执行：预算耗尽时必须明说未校验，不能让模型误以为过了。
					if (args.sha256 !== undefined) {
						hints.push("sha256 was NOT verified (the download had not settled); verification runs only when the call waits to completion.");
					}
				} else {
					const notFinished = [...new Set(watched.filter((task) => task.status === "paused" || task.status === "error").map((task) => task.status))];
					if (notFinished.length > 0) {
						hints.push(`${notFinished.map((s) => `\`${s}\``).join(" / ")} task(s) settled as paused/error — NOT finished${notFinished.includes("paused") ? "; resume with motrix (action=manage, op=resume) or poll later" : ""}.`);
					}
				}
				if (failures.length > 0) hints.push(failureHint());
				return finish({
					added: created.length,
					settled,
					tasks: await buildDownloadTasks(tasks, settled, sourceById, args.sha256, exec.signal),
					...(hints.length > 0 ? { hint: hints.join(" ") } : {})
				});
			}
		}
	}

	/* --------------------- runTasks --------------------- */
	async function runTasks(args, exec) {
		const requestedLimit = Number(args.limit ?? config.listLimit);
		const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.round(requestedLimit), 1), 200) : config.listLimit;
		// CLI 的 list 按「旧→新」排序且 limit 截断头部；取大窗口（与轮询共用 LIST_FETCH_WINDOW）
		// 后按创建时间倒序，让「最近 N 条」名副其实（模型关心的通常是新建/活跃任务）。
		const argv = ["list", "--limit", String(LIST_FETCH_WINDOW)];
		if (args.status !== undefined) {
			assertSafeCliValue(args.status, "status");
			argv.push("--status", args.status);
		}
		argv.push("--json");
		const [list, stats] = await Promise.all([
			runner.callJson(argv, { timeoutMs: config.cliTimeoutMs, signal: exec.signal, context: "list" }),
			(args.includeStats ?? true)
				? runner
						.callJson(["stats", "--json"], { timeoutMs: config.cliTimeoutMs, signal: exec.signal, context: "stats" })
						// stats 是辅助信息：取不到就降级为 undefined，不能拖垮已经拿到的任务列表。
						.catch(() => undefined)
				: Promise.resolve(undefined)
		]);
		noteTasks(list?.tasks ?? []);
		const tasks = [...(list?.tasks ?? [])]
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
			.slice(0, limit)
			.map((task) => {
				const row = projectTask(task);
				if (staleOf(task, config.staleAfterMs ?? 60000)) row.stale = true;
				return row;
			});
		return {
			total: list?.total ?? tasks.length,
			count: tasks.length,
			tasks,
			...(stats !== undefined
				? {
						stats: {
							downloadSpeedBps: stats.totalDownloadSpeed,
							uploadSpeedBps: stats.totalUploadSpeed,
							activeTasks: stats.activeTasks,
							waitingTasks: stats.waitingTasks,
							stoppedTasks: stats.stoppedTasks
						}
					}
				: {})
		};
	}

	/* --------------------- runManage --------------------- */
	async function runManage(args, exec) {
		if (args.taskIds.length === 0) throw new Error("taskIds must contain at least one task id");
		// 审查修复 #54：任务 id 也是调用方可控值，同样禁止以 "-" 开头（防 argv 注入）。
		for (const id of args.taskIds) assertSafeCliValue(id, "taskIds entry");
		assertSafeCliValue(args.action, "action");
		const wantsDeleteFiles = args.action === "remove" && (args.deleteFiles ?? false);
		// 删除文件前先取一次任务快照（一次 list 覆盖全部 id），核对文件是否仍是当初那份。
		let taskIndex = null;
		if (wantsDeleteFiles) {
			const list = await runner.callJson(["list", "--limit", String(LIST_FETCH_WINDOW), "--json"], {
				timeoutMs: config.cliTimeoutMs,
				signal: exec.signal,
				context: "list"
			});
			taskIndex = new Map((list?.tasks ?? []).map((task) => [task.id, task]));
		}
		const outcomes = await Promise.allSettled(args.taskIds.map(async (id) => {
			let deleteFiles = wantsDeleteFiles;
			let keptReason;
			if (wantsDeleteFiles) {
				const decision = await checkFileForDelete(taskIndex.get(id));
				if (decision.refuse) {
					deleteFiles = false;
					keptReason = decision.reason;
				}
			}
			const argv = [args.action, id];
			if (deleteFiles) argv.push("--delete-files");
			argv.push("--json");
			const result = await runner.call(argv, { timeoutMs: config.cliTimeoutMs, signal: exec.signal, context: `${args.action} ${id}` });
			return { result, keptReason };
		}));
		const results = [];
		let firstSystemFailure = null;
		for (const [index, outcome] of outcomes.entries()) {
			const id = args.taskIds[index];
			if (outcome.status === "rejected") {
				// spawn 级失败（CLI 缺失 / runner 已 dispose / 取消）：系统级，保留首个上抛
				if (firstSystemFailure === null) {
					firstSystemFailure = outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason));
				}
				continue;
			}
			const { result, keptReason } = outcome.value;
			if (result.code === 0) {
				results.push(keptReason === undefined ? { id, ok: true } : { id, ok: true, deletedFiles: false, keptReason });
				continue;
			}
			const failure = cliFailure(result, `${args.action} ${id}`);
			// codereview #447：退出码语义与 runner.js 的 cliFailure 共用同一份具名表
			if (result.code === EXIT_CODES.BRIDGE_UNREACHABLE || result.code === EXIT_CODES.AUTH_REJECTED || result.code === EXIT_CODES.APP_NOT_LAUNCHABLE || result.timedOut) {
				if (firstSystemFailure === null) firstSystemFailure = failure;
				continue;
			}
			results.push({ id, ok: false, error: truncate(failure.message, 300) });
		}
		if (firstSystemFailure !== null) {
			const okIds = results.filter((row) => row.ok).map((row) => row.id);
			throw new Error(
				`${firstSystemFailure.message}${okIds.length > 0 ? ` (note: ${okIds.length} task(s) already succeeded before this failure: ${okIds.join(", ")})` : ""}`
			);
		}
		return { results };
	}
	/* ---------------------------- motrix 网关 ---------------------------- */
	// 三个原工具收成一个网关（token 优化第三轮）：execute 按 action 分派到上面抽出的实现函数，
	// render 仍走各自的模型可见文本——不把结果塞进 JSON 让模型看不见。
	const RENDERS = {
		download: (_args, value) => (value?.kind === "background"
			? [{ type: "text", text: `started background job ${value.jobId}${value.label ? ` (${value.label})` : ""}; read with job_output, cancel with job_kill` }]
			: [{ type: "text", text: formatDownloadOutput(value) }]),
		tasks: (_args, value) => [{ type: "text", text: formatTasksOutput(value) }],
		manage: (_args, value) => [{
			type: "text",
			text: value.results
				.map((row) => `- ${row.id}: ${row.ok ? "ok" : `failed — ${row.error ?? "unknown error"}`}${row.keptReason ? ` (file kept: ${row.keptReason})` : ""}`)
				.join("\n") || "(no results)"
		}],
	};
	ctx.tools.register(defineTool({
		name: "motrix",
		description: "Motrix download manager.",
		parameters: {
			action: { type: "string", enum: ["download", "tasks", "manage"], required: true },
			op: { type: "string", enum: ["pause", "resume", "remove"], description: "manage: all ids." },
			taskIds: { type: "array", items: { type: "string" }, description: "manage: ids from tasks." },
			deleteFiles: { type: "boolean", description: "remove: delete files too." },
			urls: { type: "array", items: { type: "string" }, description: `dl: 1–${config.maxUrlsPerCall} URLs (http/ftp/magnet).` },
			saveDir: { type: "string", description: "dl: absolute dir (created)." },
			torrentFile: { type: "string", description: "dl: .torrent; no urls." },
			filename: { type: "string", description: "dl: rename http url." },
			connections: { type: "number", description: "dl: connections 1–64." },
			headers: { type: "array", items: { type: "string" }, description: 'dl: "Name: Value" headers.' },
			select: { type: "string", description: 'dl: indices "0,2".' },
			sha256: { type: "string", description: "dl: verify one file; wait only." },
			proxy: { type: "string", description: "dl: proxy URL (http/socks)." },
			wait: { type: "boolean", description: "dl: wait to settle (default true)." },
			waitTimeoutMs: { type: "number", description: `dl: wait cap ms (default ${config.defaultWaitTimeoutMs}).` },
			run_in_background: { type: "boolean", description: "dl: return jobId at once." },
			status: { type: "string", enum: TASK_STATUSES, description: "ls: status filter." },
			limit: { type: "number", description: `ls: max rows (default ${config.listLimit}).` },
			includeStats: { type: "boolean", description: "ls: speed totals (default true)." },
		},
		output: {
			// 单一输出 schema 覆盖三种返回结构；各 action 的字段差异由 render 保持原样。
			schema: { type: "object", additionalProperties: true },
			render: (args, value) => RENDERS[String(args.action)](args, value),
		},
		// 原三工具超时：download 最长（downloadToolTimeoutMs），tasks/manage 只是上限放宽，能力不丢。
		timeoutMs: config.downloadToolTimeoutMs,
		isConcurrencySafe: (args) => args?.action !== "manage",
		async execute(args, exec) {
			const action = args.action;
			if (action === "download") return runDownload(args, exec);
			if (action === "tasks") return runTasks(args, exec);
			if (action === "manage") {
				// 原 motrix_manage 的 action 参数与网关 action 同名：落到 op 上复用同一实现。
				if (typeof args.op !== "string") throw new Error("action=manage requires op: pause | resume | remove");
				if (!Array.isArray(args.taskIds)) throw new Error("action=manage requires taskIds (at least one id)");
				return runManage({ ...args, action: args.op }, exec);
			}
			throw new Error(`unknown action: ${action}`);
		},
	}));
}

export { registerMotrixTools };
