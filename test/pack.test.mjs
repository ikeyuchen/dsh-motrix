// test/pack.test.mjs — 发布边界测试：**测的是 tarball，不是工作区**。
//
// 动机：工作区里的文件都在，不代表 `npm publish` 后它们还在。`files` 白名单漏一项，
// npm 照样发布成功，用户装完第一次调用才炸。所以这里真的 `npm pack`，然后检查
// ① 该进包的都在 ② 开发期文件没进包 ③ lib 里的相对 import 都有对应文件 ④ 体积在上限内。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));

/** 必需文件：任何一个丢了，装上去就会残废。 */
const REQUIRED = [
	"package.json",
	"lib/index.js",
	"lib/tools.js",
	"lib/runner.js",
	"lib/inspect.js",
	"lib/guard.js",
	"cordis.patch.yml",
	"icon.svg",
	"locale/zh.json",
	"locale/en.json",
	"README.md",
	"LICENSE",
	"CHANGELOG.md"
];

/** 不允许进包的东西：开发期文件、仓库元数据、测试与文档。 */
const FORBIDDEN = ["AGENTS.md", "package-lock.json", ".gitignore", ".gitattributes", "scripts/", "test/", "docs/", ".github/"];

/** 跑 npm pack。Windows 上 npm 是 .cmd，必须过 shell；shell 模式下传完整命令串。 */
function npmPackJson(outDir) {
	const args = ["pack", "--json", "--pack-destination", outDir];
	const options = { encoding: "utf8", cwd: REPO, maxBuffer: 32 * 1024 * 1024 };
	if (process.platform === "win32") {
		const command = `npm ${args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(" ")}`;
		return execFileSync(command, { ...options, shell: true });
	}
	return execFileSync("npm", args, options);
}

/** 取一次 tarball 清单（含大小），用完删除。 */
function tarball() {
	const dir = mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "dsh-motrix-pack-"));
	try {
		const json = JSON.parse(npmPackJson(dir));
		return json[0];
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("tarball 包含全部必需文件", () => {
	const files = new Set(tarball().files.map((f) => f.path));
	for (const rel of REQUIRED) assert.ok(files.has(rel), `tarball 缺 ${rel}`);
});

test("tarball 不包含开发期文件", () => {
	const files = tarball().files.map((f) => f.path);
	for (const bad of FORBIDDEN) {
		const hit = files.find((f) => (bad.endsWith("/") ? f.startsWith(bad) : f === bad));
		assert.equal(hit, undefined, `tarball 不应包含 ${bad}（实际 ${hit}）`);
	}
});

test("package.json files 白名单每项都在 tarball 里", () => {
	const files = tarball().files.map((f) => f.path);
	for (const pattern of pkg.files) {
		const isDir = pattern.endsWith("/");
		const hasGlob = pattern.includes("*");
		const matched = files.some((f) => {
			if (isDir) return f.startsWith(pattern);
			if (hasGlob) return f.startsWith(path.dirname(pattern) + "/") && f.endsWith(path.extname(pattern));
			return f === pattern;
		});
		assert.ok(matched, `files 里的 ${pattern} 没有对应文件进包`);
	}
});

test("lib 内的相对 import 都有对应文件", () => {
	const files = new Set(tarball().files.map((f) => f.path));
	const dir = path.join(REPO, "lib");
	for (const name of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
		const text = readFileSync(path.join(dir, name), "utf8");
		for (const m of text.matchAll(/(?:from\s+|import\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
			const target = path.posix.normalize(`lib/${m[1]}`);
			assert.ok(files.has(target), `${name} 引用了 ${m[1]}，但 tarball 里没有 ${target}`);
		}
	}
});

test("tarball 体积在上限内", () => {
	const packed = tarball();
	assert.ok(packed.unpackedSize < 250 * 1024, `解包体积 ${packed.unpackedSize} 超过 250 KiB`);
	assert.ok(packed.size < 60 * 1024, `压缩体积 ${packed.size} 超过 60 KiB`);
});
