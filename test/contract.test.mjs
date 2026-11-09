import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const plugin = await import("../lib/index.js");
const { createGuardState, decideGuard } = await import("../lib/guard.js");

/** 最小 ctx：记录注册的工具、提示段与事件钩子。 */
function stubCtx() {
	const registered = new Map();
	const sections = [];
	const hooks = new Map();
	const disposers = [];
	return {
		registered,
		sections,
		hooks,
		disposers,
		ctx: {
			tools: {
				register(def) {
					registered.set(def.name, def);
					return () => registered.delete(def.name);
				},
				get(name, scope) {
					return scope === undefined || scope === "root" ? registered.get(name) : undefined;
				}
			},
			systemPrompt: {
				section(s) {
					sections.push(s);
					return () => {};
				}
			},
			effect(fn) {
				const dispose = fn();
				disposers.push(dispose);
				return dispose;
			},
			on(event, handler) {
				hooks.set(event, handler);
				return () => hooks.delete(event);
			},
			logger: { debug() {}, info() {}, warn() {}, error() {} }
		}
	};
}

test("插件导出契约", () => {
	assert.equal(plugin.name, "tool-motrix");
	assert.deepEqual(plugin.inject, ["tools", "systemPrompt"]);
	assert.equal(typeof plugin.apply, "function");
	assert.equal(typeof plugin.Config, "function");
});

test("apply 注册单个网关工具与一条系统提示", async () => {
	const { ctx, registered, sections, hooks, disposers } = stubCtx();
	const config = plugin.Config({});
	plugin.apply(ctx, config);
	assert.deepEqual([...registered.keys()], ["motrix"]);
	assert.equal(sections.length, 1);
	assert.equal(sections[0].name, "tool:motrix");
	assert.equal(sections[0].order, 2050);
	assert.ok(hooks.has("tools/pre-execute"));
	assert.equal(disposers.length, 1);
	for (const dispose of disposers) dispose();
});

test("工具参数表覆盖三个 action", () => {
	const { ctx, registered } = stubCtx();
	plugin.apply(ctx, plugin.Config({}));
	const tool = registered.get("motrix");
	assert.ok(tool);
	const params = tool.parameters?.properties ?? {};
	assert.ok(params.action, "缺 action");
	assert.deepEqual(params.action.enum, ["download", "tasks", "manage"]);
	for (const key of ["urls", "saveDir", "torrentFile", "taskIds", "op", "deleteFiles", "wait"]) {
		assert.ok(params[key], `缺参数 ${key}`);
	}
	assert.ok(tool.parameters.required.includes("action"));
});

test("配置默认值满足跨字段约束", () => {
	const config = plugin.Config({});
	assert.ok(config.downloadToolTimeoutMs > config.defaultWaitTimeoutMs);
	assert.equal(config.cliCommand, "motrix");
	assert.equal(config.listLimit, 30);
});

test("非法跨字段配置在 apply 时响亮失败", () => {
	const { ctx } = stubCtx();
	const config = plugin.Config({});
	config.downloadToolTimeoutMs = 1000;
	assert.throws(() => plugin.apply(ctx, config), /downloadToolTimeoutMs/);
});

test("bundle 声明与包名一致", () => {
	assert.equal(pkg.dsh?.manifestVersion, 1);
	assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
	const patch = fs.readFileSync(path.join(ROOT, "cordis.patch.yml"), "utf8");
	assert.ok(patch.includes(`name: '${pkg.name}'`));
});

test("内置下载守卫：拦截下载器落盘、放行只读命令", () => {
	const state = createGuardState({ guardEnabled: true, guardAllowPatterns: [], guardLargeExtensions: undefined });
	const ask = (name, args) => decideGuard({ name, arguments: args }, state);
	assert.equal(ask("bash", { command: "curl -o x.iso https://example.com/x.iso" })?.kind, "deny");
	assert.equal(ask("bash", { command: "wget -O out.zip https://example.com/a.zip" })?.kind, "deny");
	assert.equal(ask("pwsh", { command: "Invoke-WebRequest -Uri https://example.com/x.msi -OutFile x.msi" })?.kind, "deny");
	assert.equal(ask("bash", { command: "curl https://api.example.com/status" }), null);
	assert.equal(ask("read_file", { path: "x.iso" }), null);
	const off = createGuardState({ guardEnabled: false, guardAllowPatterns: [], guardLargeExtensions: undefined });
	assert.equal(decideGuard({ name: "bash", arguments: { command: "curl -o x.iso https://e/x.iso" } }, off), null);
});

test("下载守卫：误拦/漏拦回归", () => {
	const state = createGuardState({ guardEnabled: true, guardAllowPatterns: [], guardLargeExtensions: undefined });
	const kind = (name, command) => decideGuard({ name, arguments: { command } }, state)?.kind ?? "allow";
	// 必须拦截（此前漏拦的写法）
	for (const command of [
		"curl -o x.zip https://e.com/x.zip",
		"curl -O https://e.com/x.zip",
		"curl -OJ https://e.com/download?id=1",
		"curl -sLO https://e.com/x.zip",
		"wget -q https://e.com/bigfile",
		"wget -Ofoo https://e.com/x.zip",
		"sudo curl -o x.zip https://e.com/x.zip",
		"env FOO=1 curl -o x.zip https://e.com/x.zip",
		"timeout 60 curl -o x.zip https://e.com/x.zip",
		"xargs curl -O https://e.com/x.zip",
		"cd /tmp\ncurl -o x.zip https://e.com/x.zip",
		"/usr/bin/curl -o x.zip https://e.com/x.zip",
		"./curl -o x.zip https://e.com/x.zip",
		"iwr https://e.com/x.msi -OutFile x.msi",
		"bitsadmin /transfer j https://e.com/x.zip C:\\tmp\\x.zip",
		"certutil -urlcache -split -f https://e.com/x.exe x.exe",
		"aria2c https://e.com/x.iso"
	]) {
		assert.equal(kind("bash", command), "deny", `应拦截: ${command}`);
	}
	// 必须放行（此前误拦的写法）
	for (const command of [
		"grep -rn aria2c .",
		"git commit -m 'fix: aria2c cleanup'",
		"curl https://api.e.com/status",
		"curl -s https://api.e.com/status 2>/dev/null",
		"curl -I https://e.com/a.iso",
		"curl https://e.com/a.zip | tar xz",
		"git clone https://e.com/x.git",
		"npm install",
		"echo hello"
	]) {
		assert.equal(kind("bash", command), "allow", `应放行: ${command}`);
	}
	// 当前 profile 的 bash 入口是 ops_bash，同样要覆盖
	assert.equal(kind("ops_bash", "curl -o x.zip https://e.com/x.zip"), "deny");
});

test("tools/pre-execute 接线：deny 不调用 next，放行才 next", async () => {
	const { ctx, hooks } = stubCtx();
	plugin.apply(ctx, plugin.Config({}));
	const hook = hooks.get("tools/pre-execute");
	assert.equal(typeof hook, "function");
	let nextCalls = 0;
	const next = async () => {
		nextCalls += 1;
		return { kind: "allow" };
	};
	const denied = await hook({ name: "bash", arguments: { command: "curl -o x.zip https://e.com/x.zip" } }, next);
	assert.equal(denied?.kind, "deny");
	assert.equal(nextCalls, 0);
	const allowed = await hook({ name: "bash", arguments: { command: "curl https://api.e.com/status" } }, next);
	assert.equal(nextCalls, 1);
	assert.deepEqual(allowed, { kind: "allow" });
});

test("删除保护：链接/目录/大小未知时只删任务记录", async () => {
	const { checkFileForDelete } = await import("../lib/inspect.js");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-motrix-delete-"));
	try {
		const file = path.join(dir, "a.bin");
		fs.writeFileSync(file, "abc");
		const task = (over = {}) => ({ status: "completed", finalPath: file, bytesTotal: 3, ...over });
		assert.deepEqual(await checkFileForDelete(task()), { refuse: false });
		assert.equal((await checkFileForDelete(task({ bytesTotal: 4 }))).reason, "size-changed");
		assert.equal((await checkFileForDelete(task({ bytesTotal: undefined }))).reason, "size-unknown");
		assert.equal((await checkFileForDelete(task({ finalPath: path.join(dir, "missing.bin") }))).reason, "file-missing");
		assert.equal((await checkFileForDelete(task({ finalPath: dir }))).reason, "not-a-regular-file");
		assert.equal((await checkFileForDelete(undefined)).reason, "task-not-in-list-window");
		assert.deepEqual(await checkFileForDelete(task({ status: "downloading" })), { refuse: false });
		const link = path.join(dir, "link.bin");
		try {
			fs.symlinkSync(file, link);
			assert.equal((await checkFileForDelete(task({ finalPath: link }))).reason, "symlink");
		} catch {
			/* Windows 无权限建符号链接时跳过该断言 */
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
