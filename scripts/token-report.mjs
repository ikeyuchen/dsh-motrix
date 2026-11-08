#!/usr/bin/env node
/**
 * token-report —— 模型可见 token 计量（单个插件）
 *
 * 为什么需要它：工具描述、参数说明与系统提示段是**每请求常驻**的成本，
 * 改文案前后要能看见数字。口径与 DSH 宿主实际发送的内容一致：
 *   name + description + parameters + systemPrompt 段（outputSchema 不发送，不计）。
 *
 * 口径（区间，不是单点）：
 *   tokA（乐观）：CJK 1.6 字/token、ASCII 4.2 字/token
 *   tokB（保守）：CJK 1.2 字/token、ASCII 3.6 字/token
 *
 * 用法：
 *   node scripts/token-report.mjs          # 工具表 + 合计
 *   node scripts/token-report.mjs --json   # 机器可读
 *
 * 只读：不写状态、不联网。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CJK = /[\u3400-\u9FFF\uFF00-\uFFEF]/g;

function stats(text) {
	const s = String(text ?? "");
	const cjk = (s.match(CJK) || []).length;
	const ascii = s.length - cjk;
	return {
		chars: s.length,
		cjk,
		tokA: Math.round(cjk / 1.6 + ascii / 4.2),
		tokB: Math.round(cjk / 1.2 + ascii / 3.6)
	};
}

function sectionText(section) {
	if (typeof section === "string") return section;
	if (section && typeof section.text === "function") {
		try {
			const v = section.text({ scope: "root" });
			return typeof v === "string" ? v : "";
		} catch {
			return "";
		}
	}
	if (section && typeof section.text === "string") return section.text;
	return "";
}

/** 量一个插件目录（默认本仓库）的模型可见 token。 */
export async function measure(root = ROOT) {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	let entry = pkg.exports?.["."];
	if (entry && typeof entry === "object") entry = entry.import ?? entry.default ?? entry.require;
	entry = typeof entry === "string" ? entry : (pkg.main ?? "index.js");
	const mod = await import(pathToFileURL(path.join(root, entry)).href + `?t=${Date.now()}`);
	const apply = mod.apply ?? mod.default?.apply ?? (typeof mod.default === "function" ? mod.default : null);
	const Config = mod.Config ?? mod.default?.Config;
	let config = {};
	if (typeof Config === "function") {
		for (const build of [() => Config({}), () => Config]) {
			try {
				const c = build();
				if (c && typeof c === "object" && !c.type) {
					config = c;
					break;
				}
			} catch {
				/* 下一形态 */
			}
		}
	}

	const registered = new Map();
	const sections = [];
	const ctx = {
		tools: {
			register(def) {
				registered.set(def.name, def);
				return () => registered.delete(def.name);
			},
			get(n, scope) {
				return scope === undefined || scope === "root" ? registered.get(n) : undefined;
			},
			restrict() {
				return () => {};
			},
			guard() {
				return () => {};
			}
		},
		systemPrompt: {
			section(s) {
				sections.push(s);
				return () => {};
			}
		},
		effect(fn) {
			const d = fn();
			return typeof d === "function" ? d : () => {};
		},
		on() {
			return () => {};
		},
		jobs: {
			start() {
				return { id: "stub", done: Promise.resolve() };
			}
		},
		workingDirectory: {
			ensure() {
				return root;
			},
			get() {
				return root;
			}
		},
		logger: { debug() {}, info() {}, warn() {}, error() {} }
	};

	await apply(ctx, config);
	const tools = [];
	for (const def of registered.values()) {
		const payload = JSON.stringify({ name: def.name, description: def.description, parameters: def.parameters });
		tools.push({ name: def.name, ...stats(payload), descriptionChars: String(def.description ?? "").length });
	}
	const sectionStats = sections.map((s) => sectionText(s)).filter(Boolean).map((t) => stats(t));
	const toolTokA = tools.reduce((a, t) => a + t.tokA, 0);
	const toolTokB = tools.reduce((a, t) => a + t.tokB, 0);
	const sectionTokA = sectionStats.reduce((a, s) => a + s.tokA, 0);
	const sectionTokB = sectionStats.reduce((a, s) => a + s.tokB, 0);
	return {
		plugin: pkg.name,
		version: pkg.version,
		tools,
		sections: sectionStats,
		totals: {
			tools: tools.length,
			toolTokA,
			toolTokB,
			sectionTokA,
			sectionTokB,
			tokA: toolTokA + sectionTokA,
			tokB: toolTokB + sectionTokB
		}
	};
}

async function main() {
	const report = await measure(ROOT);
	if (process.argv.includes("--json")) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}
	console.log(`=== ${report.plugin}@${report.version} 模型可见 token（outputSchema 不计）===`);
	console.log("工具".padEnd(20), "字符".padStart(6), "tokA".padStart(6), "tokB".padStart(6));
	for (const t of report.tools) {
		console.log(t.name.padEnd(20), String(t.chars).padStart(6), String(t.tokA).padStart(6), String(t.tokB).padStart(6));
	}
	console.log(
		"提示段".padEnd(20),
		String(report.sections.reduce((a, s) => a + s.chars, 0)).padStart(6),
		String(report.totals.sectionTokA).padStart(6),
		String(report.totals.sectionTokB).padStart(6)
	);
	console.log("-".repeat(42));
	console.log("合计".padEnd(20), String(report.totals.tools).padStart(6), String(report.totals.tokA).padStart(6), String(report.totals.tokB).padStart(6));
	console.log(`\ntokA≈${report.totals.tokA}（1M 上下文的 ${(report.totals.tokA / 1e4).toFixed(2)}%），tokB≈${report.totals.tokB}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	await main();
}
