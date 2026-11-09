# 参与贡献

本仓库同时是 DSH 插件与 npm 包，改动会影响安装者的模型可见契约。开发约束与硬规则见
[`AGENTS.md`](AGENTS.md)，版本策略与发布流程见 [`docs/RELEASING.md`](docs/RELEASING.md)。

## 开发

环境：Node.js ≥ 22.19（或 ≥ 24），DSH `>=0.2.0-rc.2 <0.3.0`；集成自测另需 Motrix 桌面应用与
`@motrix/cli`。

```bash
npm install
```

命令清单与作用见 `AGENTS.md`「命令」。提交前至少运行 `npm test` 与 `npm run release:check`；
改动工具文案时加跑 `npm run tokens`。集成自测 `npm run selftest` 依赖真实后端，因此不进 CI。

## 提交与 PR

- 提交格式、推送规则见 `AGENTS.md`；版本号只在发布时递增。
- PR 描述写明改动与原因（链接 issue）、`npm test` 与 `npm run release:check` 的结果；涉及工具名、
  参数或枚举时，附 `npm run tokens` 前后数字与版本位。
- AI 生成的注释、文档与文案，须按 `AGENTS.md`「AI 生成内容」逐条对照实现后提交。
