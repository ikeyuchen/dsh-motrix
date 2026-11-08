# 参与贡献

感谢你有兴趣改进 dsh-motrix。这个仓库既是 DSH 插件也是 npm 包，改动会直接影响所有
安装者的模型可见契约，所以下面几条比 README 更具体。

## 开始之前

- 读 [`AGENTS.md`](AGENTS.md)：它列了会「改坏包」的硬约束（`files` 白名单、只声明
  peer 依赖、`cordis.patch.yml` 只做 insert、子进程走 `lib/runner.js`、token 预算）。
- 读 [`docs/RELEASING.md`](docs/RELEASING.md)：版本位规则与发布流程。

## 开发

```bash
npm install
npm test             # 离线契约测试 + tarball 发布边界，改完必跑
npm run tokens       # 模型可见 token 报表，改工具描述/参数前后对比
npm run release:check
```

集成自测需要本机 Motrix 桌面应用与 `@motrix/cli`，对应命令是 `npm run selftest`
（依赖真实后端，因此不进 CI）。环境要求 Node.js ≥ 22.19（或 ≥ 24）。

## 提交

- 一个提交只做一件事，信息格式 `<type>(<scope>): <subject>`，subject 用中文说明做了什么。
- type 取 `feat / fix / refactor / docs / chore / test / perf`；仓库级改动（文档、配置、发布）省略 scope。
- 日常提交不改 `package.json` 版本、不写 CHANGELOG——版本号只在准备发布时递增。
- 本地小步提交，推送前把未推送的提交合成一个；不改写已推送的历史（不 force-push）。

## Pull Request

描述里写清三件事：

1. 改了什么、为什么；对应 issue 请链接。
2. `npm test` 与 `npm run release:check` 的结果。
3. 如果动了工具名、参数或枚举，附 `npm run tokens` 的前后数字，并说明版本位
   （见 [`docs/RELEASING.md`](docs/RELEASING.md)）。

新增文件记得同时加进 `package.json` 的 `files`，否则发布后用户第一次调用才会发现缺文件。
