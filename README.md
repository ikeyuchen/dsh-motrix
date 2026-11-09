# dsh-motrix — Motrix 大文件下载（DSH 插件）

[![CI](https://github.com/ikeyuchen/dsh-motrix/actions/workflows/ci.yml/badge.svg)](https://github.com/ikeyuchen/dsh-motrix/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-motrix?logo=npm)](https://www.npmjs.com/package/dsh-motrix)
[![node](https://img.shields.io/node/v/dsh-motrix)](https://github.com/ikeyuchen/dsh-motrix/blob/main/package.json)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

把本机 [Motrix](https://motrix.app) 下载引擎接入 DeepSeek Harness（DSH），让 AI 在工作过程中
**知道并主动使用** Motrix 下载大文件：多线程分块、断点续传、失败自动重试，比 shell 里的
一次性 `curl` / `Invoke-WebRequest` 更稳，且下载在 Motrix 应用内进行——**工具调用超时或会话
中断都不会打断已开始的传输**。

单工具插件：一个模型可见的 `motrix` 网关（`action = download | tasks | manage`），外加一条
系统提示指引；下载守卫在 `tools/pre-execute` 上运行，没有工具也没有提示段，常驻 token 为 0。

## 工具

| action | 用途 |
| --- | --- |
| `download` | 添加 HTTP(S)/FTP/磁力/.torrent 下载任务（可多 URL），默认等待落定并汇报进度与最终路径；落定后校验落盘文件，可传 `sha256` 校验；`proxy` 可走 HTTP/SOCKS5 代理；`wait:false` 入队即返回 |
| `tasks` | 任务列表（进度、速度、ETA、保存路径、任务 id）与全局速度统计，用于轮询 |
| `manage` | `op = pause \| resume \| remove`；`remove` 配 `deleteFiles: true` 才删文件，且删前核对文件是否仍是当初那次下载 |

## 前置条件

1. **Motrix 桌面应用**已安装。桥接不可达时插件会**静默拉起**应用（`--opened-at-login=1`，
   只建隐藏窗口/托盘，不弹主界面）再重试；可用 `launchHidden: false` 回退到会显示窗口的旧
   `motrix open`。Linux 不支持静默拉起，会直接回退到 `motrix open`（可能弹出主窗口）。
2. **Motrix CLI**（Node.js ≥ 22.19，或 ≥ 24）：

   ```bash
   npm install -g @motrix/cli@latest
   ```

插件通过 spawn 一次性 `motrix <cmd> --json` 进程调用 CLI（Windows 上解析 npm 的 `motrix.cmd`
垫片并直接以 node 运行其入口，不经过 shell），因此 URL/请求头等参数不会被二次解释。

## 安装

**方式一：DSH 内安装（推荐）**

1. DSH →「插件」→「添加插件」
2. 输入包名 `dsh-motrix`，安装源保持「npm 官方源」
3. 点「安装」，装好后启用 `tool-motrix` 一行

**方式二：命令行（同样走 npm）**

```bash
dsh plugin add dsh-motrix
```

**方式三：源码**（本地开发或未发布版本）

```bash
git clone https://github.com/ikeyuchen/dsh-motrix.git
dsh plugin --profile web add ./dsh-motrix
```

组合包声明在 `cordis.patch.yml`，依赖按 peer 形式声明，不需要构建步骤。镜像源（npmmirror）同步
有延迟，装到的可能不是最新版，用 `npm ls dsh-motrix` 核对。源码方式装完可跑 `npm test` /
`npm run tokens` 自查；npm 包里不含 `scripts/`、`test/`。

## 配置

默认值全部写在 `lib/index.js` 的 Schemastery `Config` 里，非法配置在加载时即报错。需要覆盖时
写进 profile 的 `cordis.patch.yml`：

```yaml
- id: tool-motrix
  name: 'dsh-motrix'
  config:
    cliCommand: motrix
    autoOpen: true
    launchHidden: true
    motrixExePath: ''
    defaultWaitTimeoutMs: 600000
    listLimit: 30
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `cliCommand` | `motrix` | CLI 命令、可执行文件路径或 `.js` 入口 |
| `nodeCommand` | 空 | 运行 `.js` 入口用的 node；空 = 自动探测 |
| `autoOpen` | `true` | 桥接不可达（exit 3/6）时拉起桌面应用后重试 |
| `launchHidden` | `true` | 静默拉起（`--opened-at-login=1`，不弹主窗口） |
| `motrixExePath` | 空 | Motrix 主程序路径；空 = 自动探测常见安装位置 |
| `openTimeoutMs` | `45000` | 拉起后等待桥接就绪的上限 |
| `cliTimeoutMs` | `30000` | 单次 CLI 调用上限 |
| `addTimeoutMs` | `60000` | `add` 子命令上限 |
| `pollIntervalMs` | `2000` | 轮询间隔 |
| `defaultWaitTimeoutMs` | `600000` | `action=download` 默认等待预算 |
| `downloadToolTimeoutMs` | `960000` | 工具整体上限（须至少比默认等待预算大 30000ms，否则加载即报错） |
| `listLimit` | `30` | `action=tasks` 默认条数，上限 200 |
| `maxUrlsPerCall` | `8` | 单次最多 URL 数 |
| `stallWindowMs` | `60000` | 等待期间判定停滞的时长；0 = 关闭 |
| `staleAfterMs` | `60000` | `tasks` 标注 `[stale]` 的时长 |
| `useWatch` | `true` | 用 `motrix watch --json` 事件流降低轮询 |
| `watchPollMs` | `5000` | watch 存活时的安全轮询间隔 |
| `idempotent` | `true` | 派生幂等键，重试不建重复任务 |
| `guardEnabled` | `true` | 拦截 shell 里的大文件下载器、引导到 `motrix` |
| `guardAllowPatterns` | `[]` | 守卫放行正则 |
| `guardLargeExtensions` | 内置 15 项 | 守卫认定的「大文件」URL 后缀 |
| `endpoint` | 空 | 远端 Motrix server 地址 |
| `token` | 空 | 桥接 token（`MOTRIX_BRIDGE_TOKEN`） |

## 行为要点

- 等待循环把 `completed` / `seeding` / `paused` / `error` 视为已落定；输出经过紧凑投影，不带
  `bt.trackers` 之类大数组。
- 失败任务带 `errorCode` / `stage` / `source`，批量下载时能直接看出哪条源挂了。
- 多 URL 批量下载时单个源失败不影响其余源；失败源会在 `hint` 里列出。
- `remove` 前核对文件：文件被移走、被改过、是符号链接/目录或大小未知时只删任务记录，
  并在 `keptReason` 里说明原因。
- 停滞检测（`stallWindowMs`）在下载中的任务字节数长时间不增长时提前返回并给出处置建议；
  `fetching_metadata` 与排队中的任务不再拖住判定。
- 守卫只拦「下载器 + 明确落盘」的组合：按命令段识别（`sudo`/`env`/`timeout` 等包装、
  多行脚本、绝对路径都算），支持 `curl -o`/`-O`/`-OJ`、`wget` 默认写出、
  `Invoke-WebRequest`/`iwr -OutFile`、`aria2c`、`Start-BitsTransfer`、`bitsadmin`、
  `certutil -urlcache`、重定向落盘与大文件后缀 URL；`2>/dev/null`、`curl -I`、
  `grep aria2c` 这类只读/无关写法，以及 `git clone`、`npm install`、只读查 API 一律放行。

## 测试与自检

```bash
npm install
npm test             # 离线契约测试 + 发布边界（tarball 该有的都在、开发期文件不进包）
npm run test:pack    # 只跑发布边界
npm run tokens       # 模型可见 token 报表
npm run release:check
npm run selftest     # 集成自测：需本机 Motrix 在跑，会真实下载到临时目录
```

`selftest` 会真实驱动 Motrix：本地夹具 HTTP server → 下载 → 校验 → 清理，覆盖 `sha256`、
404 失败诊断、删除保护、幂等、参数校验与下载守卫。需要真实后端，因此不进 CI。

## 目录结构

```
lib/index.js       插件入口（defineTool + Schemastery Config；无第三方运行时依赖）
lib/tools.js       网关工具注册体与辅助
lib/runner.js      CLI 子进程管理、等待循环、静默拉起
lib/inspect.js     结果校验纯函数（失败阶段/头安全/stale/落盘校验/删除核对）
lib/guard.js       内置下载守卫（tools/pre-execute）
locale/*.json      插件页展示文案（zh/en）
cordis.patch.yml   组合包声明（向 Web 组合 insert tool-motrix 一行）
icon.svg           插件图标
test/              离线契约测试 + 发布边界测试
scripts/           token 报表、发布自检、集成自测
```

## 文档

- `docs/RELEASING.md`：版本策略（0.0.x 起步）、发布前检查、tag 发布与回滚。

## 版本与发布

当前 **0.0.4-beta.1**（beta 预览；稳定版 0.0.3）。模型可见契约仍会变，版本按 `0.0.x` 递增
（工具名/参数/枚举调整同样进 `0.0.x`，不使用 minor 位）。beta 用 `dsh plugin add dsh-motrix@beta`
安装，`latest` 不会被改动。发布流程见 `docs/RELEASING.md`：

```bash
npm run release:check
npm version prerelease --preid beta --no-git-tag-version   # 稳定版用 patch
git tag v0.0.4-beta.1 && git push origin main --tags   # release.yml 自动 npm publish
```

## 参与贡献

欢迎 issue 与 PR。动手前先读 [`CONTRIBUTING.md`](https://github.com/ikeyuchen/dsh-motrix/blob/main/CONTRIBUTING.md)
与 [`AGENTS.md`](https://github.com/ikeyuchen/dsh-motrix/blob/main/AGENTS.md)；安全问题请按
[`SECURITY.md`](https://github.com/ikeyuchen/dsh-motrix/blob/main/SECURITY.md) 私下报告。

## License

MIT
