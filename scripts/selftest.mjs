// 插件集成自测：mock 一个最小 ctx，注册工具后驱动 motrix 网关的三个 action
//（download / tasks / manage）对本机正在运行的 Motrix 走完整流程。
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";


const plugin = await import("../lib/index.js");

const registered = new Map();
const sections = [];
const disposers = [];
const hooks = new Map();
const ctx = {
	tools: {
		register(def) { registered.set(def.name, def); },
		get(name) { return registered.get(name); }
	},
	systemPrompt: { section(s) { sections.push(s); } },
	effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose; },
	// 内置守卫注册 tools/pre-execute 钩子；mock 里记下来，dispose 时移除。
	on(event, handler) {
		hooks.set(event, handler);
		return () => hooks.delete(event);
	}
};

const config = plugin.Config({});
console.log("[config defaults]", JSON.stringify(config));
plugin.apply(ctx, config);
console.log("[registered tools]", [...registered.keys()].join(", "));
console.log("[sections]", sections.map((s) => `${s.name}@${s.order}`).join(", "));
console.log("[section text visible]", sections[0].text({ scope: "root" }).slice(0, 80) + "…");

// 0) 静默拉起解析（纯函数，不启动应用，2026-10-30）：放在网络用例之前，
//    网络不可用时也能先看到这一组的结论。
{
	const runnerMod = await import("../lib/runner.js");
	const failures = [];
	const check = (name, ok, detail = "") => {
		console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
		if (!ok) failures.push(name);
	};
	const exe = runnerMod.resolveMotrixExe({}, process.env, "win32");
	check(
		"静默拉起：自动探测到本机 Motrix 主程序",
		typeof exe === "string" && exe.toLowerCase().endsWith("motrix.exe"),
		String(exe)
	);
	check("静默拉起：显式 motrixExePath 生效", runnerMod.resolveMotrixExe({ motrixExePath: exe }, process.env, "win32") === exe);
	check(
		"静默拉起：显式路径不存在时返回 undefined（回退 CLI open）",
		runnerMod.resolveMotrixExe({ motrixExePath: "Z:\\nope\\Motrix.exe" }, process.env, "win32") === undefined
	);
	check("静默拉起：隐藏参数为 --opened-at-login=1", runnerMod.HIDDEN_LAUNCH_ARGS.includes("--opened-at-login=1"));
	if (failures.length > 0) {
		console.error(`hidden-launch selftest FAILED (${failures.length}): ${failures.join("; ")}`);
		process.exitCode = 1;
	}
}

const exec = { signal: new AbortController().signal };

// S1/S2：自测期间创建的临时目录与任务统一登记，结束（含失败路径）时一次性清理。
const tmpDirs = [];
const createdTaskIds = new Set();
const mkTmp = (prefix) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
};
const trackTasks = (result) => {
	for (const task of result?.tasks ?? []) if (task.id !== undefined) createdTaskIds.add(task.id);
	return result;
};
// 删除指定任务并从待清理集合摘除；删除核对被拒/CLI 报错时打印但不抛（不阻断其余清理，最后再试一次）。
const removeTasks = async (ids) => {
	const targets = [...new Set(ids.filter(Boolean))];
	if (targets.length === 0) return undefined;
	try {
		const removed = await registered.get("motrix").execute({ action: "manage", op: "remove", taskIds: targets, deleteFiles: true }, exec);
		for (const id of targets) createdTaskIds.delete(id);
		return removed;
	} catch (error) {
		console.error("[selftest cleanup] remove failed:", String(error?.message ?? error));
		return undefined;
	}
};
const cleanupTempDirs = () => {
	for (const dir of tmpDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch (error) {
			console.error("[selftest cleanup] rmdir failed:", dir, String(error?.message ?? error));
		}
	}
};
const cleanupCreatedTasks = async () => {
	if (createdTaskIds.size === 0) return;
	const removed = await removeTasks([...createdTaskIds]);
	if (removed !== undefined) console.log("[selftest cleanup]", JSON.stringify(removed));
};

// 1b) 本地夹具 HTTP server（2026-11-06）：本机到 example.com 的 TLS 链不完整
//（unable to get local issuer certificate），外网用例会整组误判成功能失败。
// 所有下载用例改打 127.0.0.1 随机端口，语义（Range/HEAD/404/sha256/落盘）不变；
// 外网只保留末尾一条明确标注的可选 HTTPS 冒烟（失败 skip，不判 FAIL）。
const FILE_BYTES = randomBytes(64 * 1024);
const OTHER_BYTES = randomBytes(64 * 1024);
const sha256Ok = createHash("sha256").update(FILE_BYTES).digest("hex");

function serveBuffer(req, res, bytes) {
	res.setHeader("Accept-Ranges", "bytes");
	res.setHeader("Content-Type", "application/octet-stream");
	const range = req.headers.range;
	if (typeof range === "string" && range.trim() !== "") {
		const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
		let start;
		let end;
		if (match === null) {
			res.writeHead(416, { "Content-Range": `bytes */${bytes.length}` });
			res.end();
			return;
		}
		const [, rawStart, rawEnd] = match;
		if (rawStart === "") {
			const suffix = Number.parseInt(rawEnd, 10);
			start = Math.max(bytes.length - suffix, 0);
			end = bytes.length - 1;
		} else {
			start = Number.parseInt(rawStart, 10);
			end = rawEnd === "" ? bytes.length - 1 : Math.min(Number.parseInt(rawEnd, 10), bytes.length - 1);
		}
		if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= bytes.length) {
			res.writeHead(416, { "Content-Range": `bytes */${bytes.length}` });
			res.end();
			return;
		}
		res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": end - start + 1 });
		res.end(req.method === "HEAD" ? undefined : bytes.subarray(start, end + 1));
		return;
	}
	res.writeHead(200, { "Content-Length": bytes.length });
	res.end(req.method === "HEAD" ? undefined : bytes);
}

const fixtureServer = createServer((req, res) => {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405);
		res.end();
		return;
	}
	const path = new URL(req.url, "http://127.0.0.1").pathname;
	if (path === "/file.bin") return serveBuffer(req, res, FILE_BYTES);
	if (path === "/sha256-ok") return serveBuffer(req, res, FILE_BYTES);
	if (path === "/sha256-bad") return serveBuffer(req, res, OTHER_BYTES);
	res.writeHead(404, { "Content-Type": "text/plain" });
	res.end("not found");
});
await new Promise((resolve, reject) => {
	fixtureServer.once("error", reject);
	fixtureServer.listen(0, "127.0.0.1", resolve);
});
fixtureServer.unref(); // 用例中途抛错也不能因为监听句柄把进程挂住
const baseUrl = `http://127.0.0.1:${fixtureServer.address().port}`;
const fileUrl = `${baseUrl}/file.bin`;
const okUrl = `${baseUrl}/sha256-ok`;
const badUrl = `${baseUrl}/sha256-bad`;
const missingUrl = `${baseUrl}/missing`;
const closeFixture = () => new Promise((resolve) => fixtureServer.close(() => resolve()));
console.log("[fixture] local http server at", baseUrl, "| file.bin sha256 =", sha256Ok);

try {
	// 1) action=tasks
	const tasksResult = await registered.get("motrix").execute({ action: "tasks", includeStats: true }, exec);
	console.log("[tasks] total =", tasksResult.total, "count =", tasksResult.count, "stats =", JSON.stringify(tasksResult.stats));

	// 2) action=download（小文件，等待完成）
	const saveDir = mkTmp("motrix-plugin-selftest-");
	// 2026-10-24：三个工具已合并成 motrix 网关；下面所有 download 调用带 action="download"
	const download = registered.get("motrix");
	const dl = trackTasks(
		await download.execute({ action: "download", urls: [fileUrl], saveDir, wait: true, waitTimeoutMs: 60000 }, exec)
	);
	console.log("[download] settled =", dl.settled, "tasks =", JSON.stringify(dl.tasks, null, 2).slice(0, 1200));
	console.log("[download render]", download.output.render({ action: "download" }, dl)[0].text);

	// 2b) 多 URL 回归守卫（2026-10-11 修复）：CLI `add u1 u2` 是「一个任务多镜像 URI」
	//     语义而非 N 个任务——旧实现把全部 http URL 塞进一次 add，8 个文件只建 1 个任务、
	//     只下第一个。修复后 http 分支逐 URL 调 CLI（与磁力链分支同构）。
	//     守卫自带对照组语义：旧实现下 added===1，本守卫必 FAIL（exit 1）。
	{
		const failures = [];
		const check = (name, ok, detail = "") => {
			console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
			if (!ok) failures.push(name);
		};
		const dlMulti = trackTasks(
			await download.execute(
				{
					action: "download",
					urls: [fileUrl, okUrl],
					saveDir,
					wait: true,
					waitTimeoutMs: 90000
				},
				exec
			)
		);
		check("多 URL 回归：added === 2（每 URL 一任务，非镜像合并）", dlMulti.added === 2, `added=${dlMulti.added}`);
		check(
			"多 URL 回归：两任务均 completed",
			dlMulti.settled === true && (dlMulti.tasks ?? []).length === 2 && dlMulti.tasks.every((t) => t.status === "completed"),
			JSON.stringify((dlMulti.tasks ?? []).map((t) => `${t.id}:${t.status}`))
		);
		const multiIds = (dlMulti.tasks ?? []).map((t) => t.id).filter(Boolean);
		if (multiIds.length > 0) {
			const rmMulti = await removeTasks(multiIds);
			console.log("[multi-url cleanup] removed =", JSON.stringify(rmMulti));
		}
		if (failures.length > 0) {
			console.error(`multi-url guard FAILED (${failures.length}): ${failures.join("; ")}`);
			process.exitCode = 1;
		}
	}

	// 2c) 结果校验与删除保护（2026-10-19 新增）
	//     校验：未传 sha256 且文件正常 → 不挂字段（零 token）；传对/传错 → 明确 ok/reason；
	//     失败来源：404 任务应带 stage=http 与 source；删除保护：文件被改过时只删记录不删文件。
	{
		const failures = [];
		const check = (name, ok, detail = "") => {
			console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
			if (!ok) failures.push(name);
		};
		const fsp = await import("node:fs/promises");
		const { createHash } = await import("node:crypto");
		const dirA = mkTmp("motrix-verify-a-");
		const dirB = mkTmp("motrix-verify-b-");
		const dirC = mkTmp("motrix-verify-c-");
		const dirD = mkTmp("motrix-verify-d-");

		const plain = trackTasks(
			await download.execute({ action: "download", urls: [fileUrl], saveDir: dirA, wait: true, waitTimeoutMs: 60000 }, exec)
		);
		const plainTask = plain.tasks[0];
		check("未传 sha256 且文件正常 → 不挂 verification", plainTask?.verification === undefined, JSON.stringify(plainTask?.verification));
		let bytes;
		try {
			bytes = await fsp.readFile(plainTask.finalPath);
		} catch (error) {
			// 网络/证书不可用时下载可能落到 error（无 finalPath）：报告前置条件失败而不是整份自测崩溃。
			check("下载落盘（前置条件：网络/证书可用）", false, String(error?.message ?? error));
		}
		const good = createHash("sha256").update(bytes ?? Buffer.alloc(0)).digest("hex");

		const ok = trackTasks(
			await download.execute({ action: "download", urls: [okUrl], saveDir: dirB, wait: true, waitTimeoutMs: 60000, sha256: good }, exec)
		);
		check("sha256 正确 → verification.ok === true", ok.tasks[0]?.verification?.ok === true, JSON.stringify(ok.tasks[0]?.verification));
		check("sha256 正确 → render 文本可见 [sha256 ok]", download.output.render({ action: "download" }, ok)[0].text.includes("[sha256 ok]"), download.output.render({ action: "download" }, ok)[0].text);

		// /sha256-bad 的字节与 /sha256-ok 不同：用 good（来自 /file.bin）校验必定不匹配。
		const badHash = "0".repeat(64);
		const bad = trackTasks(
			await download.execute({ action: "download", urls: [badUrl], saveDir: dirC, wait: true, waitTimeoutMs: 60000, sha256: good }, exec)
		);
		check(
			"sha256 错误 → verification.ok === false / reason=sha256",
			bad.tasks[0]?.verification?.ok === false && bad.tasks[0]?.verification?.reason === "sha256",
			JSON.stringify(bad.tasks[0]?.verification)
		);

		const miss = trackTasks(
			await download.execute({ action: "download", urls: [missingUrl], saveDir: dirD, wait: true, waitTimeoutMs: 60000 }, exec)
		);
		const missTask = miss.tasks[0];
		check(
			"404 任务 → status=error + stage=not-found + source 回显",
			missTask?.status === "error" && missTask?.stage === "not-found" && missTask?.source === missingUrl,
			JSON.stringify(missTask)
		);

		const victim = ok.tasks[0]?.finalPath;
		if (!victim) {
			// 网络/证书不可用时没有落盘文件，无法构造“文件被改”场景：报告前置条件失败而不静默跳过。
			check("删除保护（前置条件：下载成功且有落盘文件）", false, "no finalPath — network/TLS failure");
		} else {
			await fsp.appendFile(victim, "tampered");
			const managed = await removeTasks([ok.tasks[0].id]);
			const row = managed.results[0];
			check("文件被改 → keptReason=size-changed 且只删记录", row?.ok === true && row?.deletedFiles === false && row?.keptReason === "size-changed", JSON.stringify(row));
			const stillThere = await fsp.stat(victim).then(() => true).catch(() => false);
			check("文件确实保留", stillThere === true);
		}

		// 参数校验：sha256 的非法组合必须响亮失败（不许静默丢掉校验请求）
		const expectThrow = async (label, args, pattern = /sha256/) => {
			try {
				await download.execute({ ...args, action: "download" }, exec);
				check(label, false, "未抛错");
			} catch (error) {
				const message = String(error?.message ?? error);
				check(label, pattern.test(message), message);
			}
		};
		await expectThrow("sha256 + wait:false 被拒绝", { urls: [fileUrl], saveDir: dirA, wait: false, sha256: good });
		await expectThrow("sha256 + 多 URL 被拒绝", { urls: [fileUrl, okUrl], saveDir: dirA, sha256: good });
		await expectThrow("sha256 非 64 位十六进制被拒绝", { urls: [fileUrl], saveDir: dirA, sha256: "xyz" });
		// 不兼容旗标组合必须响亮失败（禁止静默丢弃调用方意图）
		const magnet = "magnet:?xt=urn:btih:0000000000000000000000000000000000000000";
		await expectThrow("filename + 磁力被拒绝", { urls: [magnet], saveDir: dirA, filename: "x.bin" }, /filename/);
		await expectThrow("select + http 被拒绝", { urls: [fileUrl], saveDir: dirA, select: "0" }, /select/);
		await expectThrow("headers + 磁力被拒绝", { urls: [magnet], saveDir: dirA, headers: ["X-Test: 1"] }, /headers/);
		// 代理/请求头白名单（不允许破坏 aria2 内部行为）
		await expectThrow("非法代理 scheme 被拒绝", { urls: [fileUrl], saveDir: dirA, proxy: "file:///etc/passwd" }, /proxy/);
		await expectThrow("缺 host 的代理被拒绝", { urls: [fileUrl], saveDir: dirA, proxy: "socks5://" }, /proxy/);
		await expectThrow("Range 头被拒绝", { urls: [fileUrl], saveDir: dirA, headers: ["Range: bytes=0-1"] }, /override/i);
		await expectThrow("含 CRLF 的头被拒绝", { urls: [fileUrl], saveDir: dirA, headers: ["X-Test: a\r\nX-Evil: 1"] }, /CR\/LF/);
		await expectThrow("非法 header 名被拒绝", { urls: [fileUrl], saveDir: dirA, headers: ["Bad Name: 1"] }, /invalid header name/);
		// 幂等：同一请求重复调用 → 同一任务；删除后可重新下载（不返回幽灵 id）
		const dirIdem = mkTmp("motrix-idem-");
		const idemReq = { urls: [fileUrl], saveDir: dirIdem, wait: false };
		const idem1 = trackTasks(await download.execute({ ...idemReq, action: "download" }, exec));
		const idem2 = trackTasks(await download.execute({ ...idemReq, action: "download" }, exec));
		check(
			"幂等：重复请求返回同一任务",
			idem1.tasks[0]?.id !== undefined && idem1.tasks[0]?.id === idem2.tasks[0]?.id,
			`${idem1.tasks[0]?.id} vs ${idem2.tasks[0]?.id}`
		);
		const idemId = idem1.tasks[0]?.id;
		if (idemId) {
			await removeTasks([idemId]);
			await new Promise((resolve) => setTimeout(resolve, 600));
			const idem3 = trackTasks(await download.execute({ ...idemReq, action: "download" }, exec));
			check(
				"幂等：任务删除后可重新下载（非幽灵 id）",
				idem3.tasks[0]?.id !== undefined && idem3.tasks[0]?.id !== idemId,
				`${idemId} -> ${idem3.tasks[0]?.id}`
			);
			if (idem3.tasks[0]?.id) {
				await removeTasks([idem3.tasks[0].id]);
			}
		}

		const cleanupIds = [plainTask, bad.tasks[0], missTask].map((t) => t?.id).filter(Boolean);
		if (cleanupIds.length > 0) {
			const cleaned = await removeTasks(cleanupIds);
			console.log("[verify cleanup]", JSON.stringify(cleaned));
		}
		if (failures.length > 0) {
			console.error(`verify guard FAILED (${failures.length}): ${failures.join("; ")}`);
			process.exitCode = 1;
		}
	}

	// 2d) 内置下载守卫（合并自 dsh-plugin-motrix-guard，2026-10-19）
	{
		const { createGuardState, decideGuard } = await import("../lib/guard.js");
		const failures = [];
		const check = (name, ok, detail = "") => {
			console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
			if (!ok) failures.push(name);
		};
		const state = createGuardState({ guardEnabled: true, guardAllowPatterns: [], guardLargeExtensions: undefined });
		const ask = (name, args) => decideGuard({ name, arguments: args }, state);
		check("守卫：curl -o 大文件被拦", ask("bash", { command: "curl -o x.iso https://example.com/x.iso" })?.kind === "deny");
		check("守卫：wget -O 被拦", ask("bash", { command: "wget -O out.zip https://example.com/a.zip" })?.kind === "deny");
		check("守卫：aria2c 被拦", ask("bash", { command: "aria2c https://example.com/a.bin" })?.kind === "deny");
		check(
			"守卫：Invoke-WebRequest -OutFile 被拦",
			ask("pwsh", { command: "Invoke-WebRequest -Uri https://example.com/x.msi -OutFile x.msi" })?.kind === "deny"
		);
		check("守卫：curl 查 API 放行", ask("bash", { command: "curl https://api.example.com/status" }) === null);
		check("守卫：curl.exe 查 API 放行（.exe 不是大文件后缀）", ask("pwsh", { command: "curl.exe -s https://example.com/ | Select-Object -First 2" }) === null);
		check("守卫：非 shell 工具放行", decideGuard({ name: "read_file", arguments: { path: "x.iso" } }, state) === null);
		const allowState = createGuardState({ guardEnabled: true, guardAllowPatterns: ["example\\.com/x\\.iso"], guardLargeExtensions: undefined });
		check(
			"守卫：guardAllowPatterns 命中放行",
			decideGuard({ name: "bash", arguments: { command: "curl -o x https://example.com/x.iso" } }, allowState) === null
		);
		const offState = createGuardState({ guardEnabled: false, guardAllowPatterns: [], guardLargeExtensions: undefined });
		check("守卫：guardEnabled=false 全放行", decideGuard({ name: "bash", arguments: { command: "curl -o x.iso https://e/x.iso" } }, offState) === null);
		if (failures.length > 0) {
			console.error(`guard selftest FAILED (${failures.length}): ${failures.join("; ")}`);
			process.exitCode = 1;
		}
	}

	// 2e) 可选：外网 HTTPS 冒烟（只在网络/证书可用时才算数；失败 SKIP，不判 FAIL）
	//     本机 TLS 链不完整：不计入退出码，仅用来看外网行为有没有变化。
	console.log("[network smoke] optional https://example.com/ — requires working TLS; failure = SKIP, not FAIL");
	{
		const smokeDir = mkTmp("motrix-net-smoke-");
		try {
			const smoke = trackTasks(
				await download.execute(
					{ action: "download", urls: ["https://example.com/"], saveDir: smokeDir, wait: true, waitTimeoutMs: 30000 },
					exec
				)
			);
			const task = (smoke.tasks ?? [])[0];
			console.log(
				task?.status === "completed"
					? "PASS  外网 HTTPS 冒烟（可选，非退出码依据）"
					: `SKIP  外网 HTTPS 冒烟（可选，网络/证书不可用）：${task?.error ?? task?.status ?? "no task"}`
			);
			const smokeIds = (smoke.tasks ?? []).map((t) => t.id).filter(Boolean);
			if (smokeIds.length > 0) {
				await removeTasks(smokeIds);
			}
		} catch (error) {
			console.log("SKIP  外网 HTTPS 冒烟（可选，网络/证书不可用）：" + String(error?.message ?? error).slice(0, 140));
		}
	}

	// 3) wait:false 快速入队 + manage 清理
	const dl2 = trackTasks(await download.execute({ action: "download", urls: [fileUrl], saveDir, wait: false }, exec));
	console.log("[quick add] hint =", dl2.hint, "first id =", dl2.tasks[0]?.id);
	if (dl2.tasks[0]?.id) {
		const rm = await removeTasks([dl2.tasks[0].id]);
		console.log("[manage op=remove]", JSON.stringify(rm));
	}

	// 4) 参数校验（应报 usage 级错误而非崩溃；空 urls 被接受必须计入失败与退出码）
	let emptyUrlsRejected = false;
	try {
		await download.execute({ action: "download", urls: [], saveDir }, exec);
		console.log("FAIL  [validation] empty urls accepted");
	} catch (error) {
		console.log("[validation] ok:", error.message);
		emptyUrlsRejected = true;
	}
	if (!emptyUrlsRejected) {
		console.error("validation guard FAILED (1): [validation] empty urls accepted");
		process.exitCode = 1;
	}
} finally {
	// S1/S2/S3：无论断言失败还是 download.execute 抛错，都统一清掉本次自测创建的任务与临时目录。
	// 删除核对可能被拒（文件被改等）：removeTasks 只打印、不抛，剩余任务在这里再试一次。
	await cleanupCreatedTasks();
	cleanupTempDirs();
}
// 5) 卸载清理（ctx.effect 登记的 disposer 应能安全执行）
for (const dispose of disposers) dispose();
console.log("[dispose]", disposers.length, "disposer(s) ran without error");

// 6) 关闭本地夹具 server（不关会把监听句柄留在事件循环里）
await closeFixture();
console.log("[fixture] local http server closed");

console.log("SELFTEST DONE");

