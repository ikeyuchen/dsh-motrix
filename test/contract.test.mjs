import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
