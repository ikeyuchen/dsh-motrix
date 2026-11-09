#!/usr/bin/env node
/**
 * release-check —— 发布前自检（离线）
 *
 * 覆盖：包元数据、文件清单、组合包行、locale、CHANGELOG 与版本一致、
 * 常驻 token 预算、旧包名/本机路径残留、无运行时依赖。
 *
 * 用法：node scripts/release-check.mjs
 * 退出码：0 通过，1 失败（逐条打印 FAIL）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { measure } from "./token-report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 工具 + 提示段的 tokA 预算。超出说明文案重新膨胀了，先跑 npm run tokens 看明细。 */
const TOKEN_BUDGET_A = 460;

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const pkg = JSON.parse(read("package.json"));

// 1) 元数据
const meta = ["name", "version", "description", "license", "author", "repository", "homepage", "bugs", "publishConfig", "files", "engines", "peerDependencies", "icon"];
const missing = meta.filter((k) => !pkg[k]);
check("package.json 元数据齐全", missing.length === 0, missing.length ? `缺 ${missing.join(", ")}` : "");
check("publishConfig.access = public", pkg.publishConfig?.access === "public");
check("dsh.manifestVersion 存在", Boolean(pkg.dsh?.manifestVersion));
check("dsh.bundle.patch 指向 cordis.patch.yml", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");
check("无运行时 dependencies", Object.keys(pkg.dependencies ?? {}).length === 0);
check("导出入口存在", Boolean(pkg.exports?.["."]) && fs.existsSync(path.join(ROOT, pkg.main ?? "")));
check("engines.node 声明", Boolean(pkg.engines?.node));
check("engines.dsh 声明", Boolean(pkg.engines?.dsh));

// 2) 文件清单（支持目录与 * 通配）
for (const pattern of pkg.files ?? []) {
	if (pattern.includes("*")) {
		const dir = path.join(ROOT, path.dirname(pattern));
		const ext = path.extname(pattern);
		const hits = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(ext)) : [];
		check(`files: ${pattern}`, hits.length > 0);
	} else {
		const target = path.join(ROOT, pattern);
		check(`files: ${pattern}`, fs.existsSync(target));
	}
}

// 3) 组合包行
const patch = read("cordis.patch.yml");
check("cordis.patch.yml 引用本包名", patch.includes(`name: '${pkg.name}'`));
check("cordis.patch.yml 行 id = tool-motrix", /id:\s*tool-motrix/.test(patch));

// 4) locale
for (const lang of ["zh", "en"]) {
	let meta2 = null;
	try {
		meta2 = JSON.parse(read(`locale/${lang}.json`)).meta;
	} catch {
		/* 下面统一判 */
	}
	check(`locale/${lang}.json 有 meta.title/description`, Boolean(meta2?.title && meta2?.description));
}

// 5) CHANGELOG 最新小节版本 = package.json 版本（支持 0.0.4-beta.0 这类 prerelease）
const changelog = read("CHANGELOG.md");
const versionPattern = "([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.]+)?)";
const m = changelog.match(new RegExp(`^##\\s+${versionPattern}`, "m"));
check("CHANGELOG 最新版本与 package.json 一致", m?.[1] === pkg.version, m ? `${m[1]} vs ${pkg.version}` : "未找到版本标题");

// 5b) README 的「当前 **x.y.z**」也要跟着版本走（此前只查 CHANGELOG，README 会滞留旧版本）
const readme = read("README.md");
const rm = readme.match(new RegExp(`当前 \\*\\*${versionPattern}\\*\\*`));
check("README 版本声明与 package.json 一致", rm?.[1] === pkg.version, rm?.[1] ? `${rm[1]} vs ${pkg.version}` : "未找到「当前 **x.y.z**」");

// 6) token 预算
const report = await measure(ROOT);
check(`常驻 token 预算 tokA ≤ ${TOKEN_BUDGET_A}`, report.totals.tokA <= TOKEN_BUDGET_A, `实测 ${report.totals.tokA}（tokB ${report.totals.tokB}）`);
check("只有一个模型可见工具", report.totals.tools === 1, `实测 ${report.totals.tools}`);

// 7) 旧包名 / 本机绝对路径残留（CHANGELOG 记录迁移历史，豁免；lib 注释里的历史
//    插件名 `dsh-plugin-motrix-guard` 不算旧包名）
const scan = ["README.md", "package.json", "cordis.patch.yml", "lib/index.js", "lib/tools.js", "lib/runner.js", "lib/inspect.js", "lib/guard.js", "AGENTS.md"];
const docs = ["README.md", "AGENTS.md"];
for (const rel of scan) {
	const text = read(rel);
	check(`${rel} 无旧包名残留`, !/dsh-plugin-motrix(?!-guard)/.test(text));
	if (docs.includes(rel)) check(`${rel} 无本机盘符路径`, !/[A-Za-z]:\\/.test(text));
}

if (failures.length > 0) {
	console.error(`\nrelease-check FAILED (${failures.length}): ${failures.join("; ")}`);
	process.exitCode = 1;
} else {
	console.log("\nrelease-check passed.");
}
