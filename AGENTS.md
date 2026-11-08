# AGENTS.md — dsh-motrix 开发指引

给在本仓库工作的 AI 代理（以及人）的操作约束。**只写容易踩错的**，不重复 README 已讲的功能。

## 命令

```bash
npm test              # 离线契约测试 + 发布边界测试（tarball 内容），改完必跑
npm run test:pack     # 只跑发布边界：npm pack 后检查该有的都在、开发期文件没进包
npm run tokens        # 模型可见 token 报表（改工具描述/参数说明前后必跑）
npm run release:check # 发布前静态检查（版本一致/预算/清单/patch/文案），发版前必跑
npm run selftest      # 集成自测：需本机 Motrix 与 @motrix/cli 在跑，会真实下载到临时目录
npm pack --dry-run    # 看最终会进包的文件
```

`test/` 按用途分文件（`contract` 契约与行为、`pack` 发布边界）。新增能力扩对应文件，
不要再加第二个测试入口。`selftest` 需要真实后端，因此不进 CI。

## 硬约束（违反会坏包）

- **只声明 `peerDependencies`，不引入运行时 `dependencies`**：宿主按 peer 申报路由到自带副本；
  `install_bundle` 的 pnpm 会接管 link 包依赖，加主包可能被删。
- **新文件必须同时进 `package.json` 的 `files`**：漏一项，npm 发布成功、用户装完第一次调用才炸。
  `test/pack.test.mjs` 是唯一在 tarball 层面发现该问题的测试。仓库侧文档（`CONTRIBUTING.md`、
  `SECURITY.md`、`.github/`、`docs/`、`test/`、`scripts/`）是例外：它们只给 GitHub 看，不进包。
- **`cordis.patch.yml` 只做 `insert`**：行 id `tool-motrix`，包名与 `package.json` 一致，不改其它层。
- **工具描述与参数说明是每请求常驻 token**：只写「做什么 + 返回什么 + 一条约束」，参数说明一句话。
  改完跑 `npm run tokens`，预算由 `release:check` 把关（tokA ≤ 460）。
- **路径不写死盘符**：机器相关值只走 Config（`cliCommand` / `motrixExePath` / `endpoint`），
  默认值写在 `lib/index.js` 的 schema 里。
- **子进程一律走 `lib/runner.js`**：必须能被 `ctx.effect` 清理，不吞取消信号；长任务走 `ctx.jobs`。
- **平台差异用运行时探测**（`win32` / `darwin` / linux 分支），不按开发机写死；不改 CLI 参数语义。
- **版本号只在准备发布时递增**，日常提交不改版本、不写 CHANGELOG。

## 容易忘的仓库结构决策

| 决策 | 原因 | 依据 |
|---|---|---|
| 一个网关工具 `motrix`，不是三个工具 | 三个工具各带一张参数表，常驻 token 更高；`action` 复用同一张表 | 2026-10-24 实测 3→1 |
| 包名 `dsh-motrix`、行 id `tool-motrix` | 包名是安装标识、行 id 是组合层标识，两者解耦；短前缀与兄弟仓库一致 | `docs/RELEASING.md` |
| 下载守卫没有工具也没有提示段 | 只在 `tools/pre-execute` 上拦窄口径命令，常驻 token 为 0；自身异常一律 `next()` | `lib/guard.js` |
| `selftest` 不进 CI | 需要真实 Motrix、CLI 与网络；CI 只跑离线契约与发布边界 | `scripts/selftest.mjs` |
| 版本 0.0.x 起步 | 工具名、参数、枚举仍是会变的模型可见契约 | `docs/RELEASING.md` |

## 提交与推送

**提交信息**：`<type>(<scope>): <subject>`。

- type ∈ feat / fix / refactor / docs / chore / test / perf；仓库级改动（文档、配置、发布）省略 scope。
- subject 用中文写清做了什么，不写过程；一次提交只做一件事。
- 提交身份固定 `ikeyuchen <ikeyuchen@users.noreply.github.com>`（已写入 `git config --local`，换机器要重设）。

**本地小步提交，攒够再推**：不要频繁推送；推前把未推送的提交合成一个：
`git reset --soft origin/main` 后重提，或 `git rebase -i origin/main`。**不改写已推送的历史**（不 force-push）。

**变更写进 CHANGELOG**：只写用户能感知的变化，分区固定 `新增功能 / 体验优化 / 问题修复 / 其他变更`。

## 改完的自检顺序

1. `npm test` —— 契约 + 发布边界（一次跑完）
2. 若动了 `lib/`：再连跑一次确认没有不确定性
3. 若动了工具签名或文案：`npm run tokens` 看数字，同步 README / CHANGELOG，并确认 `release:check` 预算通过
4. 若动了发布相关文件：`npm pack --dry-run` 核对清单
5. 准备发布：按 `docs/RELEASING.md` 走完整流程
