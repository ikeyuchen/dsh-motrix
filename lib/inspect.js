/**
 * dsh-motrix / lib/inspect.js
 * ==================================
 * 与工具注册无关的「结果检查」纯函数（从 lib/tools.js 拆出，守 1000 行上限）：
 *   - stageOf：失败阶段收敛（可处置枚举）；
 *   - assertSafeHeader：请求头安全（合法性 / CRLF / 禁止覆盖 aria2 内部头）；
 *   - noteTasks / staleOf：任务进展历史与 stale 标注；
 *   - sha256File / verifyTask：落盘校验（存在 / 大小 / sha256）；
 *   - checkFileForDelete：删除前文件一致性核对。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, stat } from "node:fs/promises";

/** 失败阶段收敛：把 CLI 的 errorCode / error 文本映射成有限枚举，模型据此决定
 * 重试（network/http）、补请求头（auth）、换目录（disk）还是换源（bt）。
 * 只认模式不认具体码值，CLI 改措辞也不会退化成 unknown（借鉴 dsh-fetch-file 的 stage 枚举）。 */
const STAGE_RULES = [
	["timeout", /timeout|timed out|deadline|超时/i],
	["auth", /\bauth|unauthor|forbidden|\b401\b|\b403\b|token|credential/i],
	["not-found", /dl_not_found|not[ -]?found|\b404\b/i],
	["network", /network|dns|econn|connect|reset|refus|unreachable|offline/i],
	["http", /\bhttp\b|status|\b[45]\d\d\b/i],
	["disk", /disk|enospc|no space|eacces|eperm|write|read-only/i],
	["bt", /\bbt\b|torrent|magnet|peer|tracker|dht|infohash/i]
];

function stageOf(errorCode, errorText) {
	const hay = `${errorCode ?? ""} ${errorText ?? ""}`;
	for (const [stage, pattern] of STAGE_RULES) {
		if (pattern.test(hay)) return stage;
	}
	return errorCode ? "engine" : undefined;
}

/** 请求头安全：合法名、无 CR/LF、不允许覆盖 aria2 自己管理的头（Range/Content-Length 等）。 */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const FORBIDDEN_HEADERS = new Set(["range", "content-length", "accept-encoding", "host", "connection", "transfer-encoding"]);

function assertSafeHeader(header, label) {
	const index = header.indexOf(":");
	if (index <= 0) throw new Error(`${label} must look like "Name: Value"`);
	const name = header.slice(0, index).trim();
	const value = header.slice(index + 1);
	if (!HEADER_NAME.test(name)) throw new Error(`${label} has an invalid header name`);
	if (/[\r\n]/.test(value)) throw new Error(`${label} value must not contain CR/LF`);
	if (FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new Error(`${label} may not override ${name}; aria2 manages it internally`);
	return header;
}

/** 任务进展历史：action=tasks 用它标记 stale；等待循环用它判定停滞。只在内存里保留最近若干条。 */
const taskHistory = new Map();

function noteTasks(tasks) {
	const now = Date.now();
	for (const task of tasks) {
		if (task.id === undefined) continue;
		const prev = taskHistory.get(task.id);
		const bytes = typeof task.bytesDone === "number" ? task.bytesDone : undefined;
		// 状态变化也是「有进展」：queued/fetching_metadata 阶段字节数长期为 0，
		// 只看 bytes 会让排队任务在 staleAfterMs 后被永久标成 [stale]。
		if (prev === undefined || prev.bytesDone !== bytes || prev.status !== task.status) {
			taskHistory.set(task.id, { bytesDone: bytes, status: task.status, changedAt: now });
		}
	}
	// 上限：超过 2000 条时按最后变化时间删最旧的一批（旧的 24h 阈值在近期条目多时清不掉，
	// 与「避免无界增长」的目标相反）。
	if (taskHistory.size > 2000) {
		const overflow = taskHistory.size - 2000;
		const oldest = [...taskHistory.entries()].sort((a, b) => a[1].changedAt - b[1].changedAt).slice(0, overflow);
		for (const [id] of oldest) taskHistory.delete(id);
	}
}

function staleOf(task, staleAfterMs) {
	// queued 不参与 stale：排队不是异常，且它没有字节进展可依据。
	if (!["fetching_metadata", "downloading", "finalizing"].includes(task.status)) return false;
	const entry = taskHistory.get(task.id);
	return entry !== undefined && Date.now() - entry.changedAt >= staleAfterMs;
}

/** 流式计算文件 sha256；尊重调用的中止信号（大文件哈希可能耗时数十秒）。 */
function sha256File(path, signal) {
	return new Promise((resolve, reject) => {
		// 预中止：abort 事件早已派发时，下面的 addEventListener 永不触发，哈希会白跑完整个大文件。
		if (signal?.aborted) {
			reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
			return;
		}
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const onAbort = () => stream.destroy(new Error("aborted"));
		signal?.addEventListener("abort", onAbort, { once: true });
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", (error) => {
			cleanup();
			reject(error);
		});
		stream.on("end", () => {
			cleanup();
			resolve(hash.digest("hex"));
		});
	});
}

/** 落定任务的结果校验：文件是否还在、大小是否相符、可选 sha256 是否一致。
 * 成功且未请求 sha256 时返回 undefined（不占上下文）；只有异常或用户显式校验才产出字段。
 * 借鉴 dsh-smart-download 的 presence 边界：下载完的文件也可能被移走/改过，
 * 「任务 completed」并不等于「文件还在且是当初那份」。 */
async function verifyTask(task, expectedSha256, signal) {
	if (task.status !== "completed" && task.status !== "seeding") return undefined;
	if (typeof task.finalPath !== "string" || task.finalPath === "") return undefined;
	let info;
	try {
		info = await stat(task.finalPath);
	} catch (error) {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
		// ENOENT/ENOTDIR 才是「不在原位」；EACCES/EPERM/EMFILE 等是另一回事，不能混报。
		if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { ok: false, reason: "missing" };
		return { ok: false, reason: "stat-error" };
	}
	if (!info.isFile()) {
		// 多文件种子的 finalPath 可能是目录：存在性即通过；sha256 对目录无定义。
		return expectedSha256 === undefined ? undefined : { ok: false, reason: "sha256-needs-file" };
	}
	const expectedBytes = Number.isFinite(task.bytesTotal) && task.bytesTotal > 0 ? task.bytesTotal : undefined;
	if (expectedBytes !== undefined && info.size !== expectedBytes) {
		return { ok: false, reason: "size", expectedBytes, actualBytes: info.size };
	}
	if (expectedSha256 === undefined) return undefined;
	let actual;
	try {
		actual = await sha256File(task.finalPath, signal);
	} catch (error) {
		// 调用取消要上抛；纯读盘失败（EACCES/占用）不能把已完成的下载判成失败。
		if (signal?.aborted) throw error;
		return { ok: false, reason: "unreadable" };
	}
	if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
		return { ok: false, reason: "sha256", expectedSha256, actualSha256: actual };
	}
	return { ok: true, sha256: "match" };
}

/** 删除前核对：只保护「已完成/做种中且大小仍相符」的文件。不一致或已不在原位时
 * 不带 --delete-files（只删任务记录）——对应 dsh-smart-download 的 presence 边界：
 * 文件被改过就不再代表当初那次下载，删掉就不是「清理自己的下载」了。 */
async function checkFileForDelete(task) {
	if (task === undefined) return { refuse: true, reason: "task-not-in-list-window" };
	if (task.status !== "completed" && task.status !== "seeding") return { refuse: false };
	if (typeof task.finalPath !== "string" || task.finalPath === "") return { refuse: false };
	let info;
	try {
		// lstat 不跟随链接：finalPath 被换成 symlink/junction 时不能 --delete-files，
		// 否则删的是链接指向的位置，可能根本不是「当初那次下载」。
		info = await lstat(task.finalPath);
	} catch {
		return { refuse: true, reason: "file-missing" };
	}
	if (info.isSymbolicLink()) return { refuse: true, reason: "symlink" };
	// 目录（多文件种子的 finalPath）不在「清理自己的下载」范围内：递归删可能带走
	// 用户后来放进同一目录的文件，只删任务记录更安全。
	if (!info.isFile()) return { refuse: true, reason: "not-a-regular-file" };
	const expected = Number.isFinite(task.bytesTotal) && task.bytesTotal > 0 ? task.bytesTotal : undefined;
	// 大小未知就无法核对「仍是当初那份」，按删除保护口径拒绝带 --delete-files。
	if (expected === undefined) return { refuse: true, reason: "size-unknown" };
	if (info.size !== expected) return { refuse: true, reason: "size-changed" };
	return { refuse: false };
}

export { assertSafeHeader, checkFileForDelete, noteTasks, sha256File, stageOf, staleOf, verifyTask };
