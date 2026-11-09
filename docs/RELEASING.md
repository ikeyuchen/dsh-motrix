# 发布流程

## 版本策略（0.0.x 起步）

对外首发定为 **0.0.1**（2026-11-08 已发布）：工具名、参数、枚举值都是模型与用户看到的契约，还会变。
版本号只沿 `0.0.x` 递增（0.0.1 → 0.0.2 → …），**不使用 0.x.0 minor 位**。

| 变更 | 版本位 | 例子 |
|---|---|---|
| 修 bug、改文档、改文案 | **0.0.x**（patch） | 修正停滞检测的提示；压缩参数说明 |
| **任何模型可见契约变化** | **0.0.x**（同 patch 位） | 加/改名工具、加减参数、改枚举 |
| 契约稳定后 | 1.0.0 | — |

一条容易误判：**工具描述与参数说明占常驻 token**，只改文案不算契约变更，但改完要跑
`npm run release:check` 确认没爆预算（当前预算 tokA ≤ 460）。

## Beta 预发布

要用 npm 先给用户试新版本、又不影响稳定版时发 beta：

```bash
npm version prerelease --preid beta --no-git-tag-version   # 0.0.3 → 0.0.4-beta.0
# 同步 README「当前 **x.y.z**」与 CHANGELOG 小节，跑 npm run release:check
git tag v0.0.4-beta.0 && git push origin main --tags
```

`release.yml` 检测到版本号含 `-` 会自动 `npm publish --tag beta`，**`latest` 保持稳定版不动**；
安装 beta 用 `dsh plugin add dsh-motrix@beta`（或 npm `npm i dsh-motrix@beta`）。转正时发不带 `-`
的稳定版，CI 会把它发回 `latest`；`npm dist-tag ls dsh-motrix` 可核对两个 tag 各指向哪版。

## 发布前检查

静态项已自动化（`prepublishOnly` 先跑 `npm run release:check`）：包元数据齐全、`files` 清单里的
文件都在、组合包行与包名一致、locale 有标题、CHANGELOG 最新小节版本与 `package.json` 一致、
常驻 token 在预算内、无旧包名与本机盘符残留。

动态项必须另跑：

```bash
npm test            # 离线契约测试 + 发布边界测试（tarball 里该有的都有、开发期文件不进包）
npm run tokens      # 模型可见 token 报表，改工具文案前后对比
npm run selftest    # 集成自测：需本机 Motrix 在跑，会真实下载到临时目录
npm pack --dry-run  # 看最终会进包的文件
```

人工项（机器判不了）：新参数在 `README.md` 的配置表里有位置；`AGENTS.md` 的硬规则没与现状矛盾；
从 npm 装一次冒烟（插件页输入 `dsh-motrix` 或 `dsh plugin add dsh-motrix`）；确认目标版本尚未
发布（`npm view dsh-motrix@<version>` 返回 404）。

## 首次发布到 GitHub（已完成）

仓库已建立并推送到 `https://github.com/ikeyuchen/dsh-motrix`（public，2026-11-08）；下面是留档的
初始化步骤，换机器或重建仓库时照做。远端已在本地配置好，日常只需 `git push`。

```bash
git remote add origin https://github.com/ikeyuchen/dsh-motrix.git
git push -u origin main
```

用 `gh` 时一条命令等价：`gh repo create ikeyuchen/dsh-motrix --public --source=. --remote=origin --push`。

仓库设置（网页或 `gh repo edit`，不落仓库文件）：

- Description：`DSH 插件：用本地 Motrix 引擎多线程、断点续传下载大文件（HTTP/FTP/磁力/.torrent）`
- Topics：`dsh` `dsh-plugin` `deepseek-harness` `cordis` `motrix` `download` `downloader` `aria2` `bittorrent` `magnet`
- Settings → Secrets and variables → Actions → `NPM_TOKEN`（Granular token，`read-write`，只限本包）
- Settings → Branches → 保护 `main`：合并前要求 CI 的 3 个检查全部通过
  （windows / ubuntu × Node 22，ubuntu × Node 24；单人仓库也建议开，防止本地漏跑测试就推送）

`release.yml` 在 tag 推送后自动建 GitHub Release（标题为 tag，正文是提交摘要）。想用 CHANGELOG
正文覆盖，发布后执行：`gh release edit v0.0.3 --notes-file <摘出的 CHANGELOG 小节>`。

## 发布

日常发布前确保本地 `main` 与 `origin/main` 同步（首次推送已完成），再合成本地未推送的提交：

```bash
# 1) 写 CHANGELOG：当前版本 + 日期，只写用户可见的新增 / 优化 / 修复
# 2) 合成本地未推送的提交（一次推送只推一个提交）
git reset --soft origin/main
git add -A && git commit -m "chore(release): v0.0.3"
# 3) 打 tag 推送
git tag v0.0.3
git push origin main --tags
```

`.github/workflows/release.yml` 在 tag 推送后自动：`npm ci` → `npm test` → 校验 tag
（去掉 `v`）等于 `package.json.version` → `npm publish --access public --provenance` →
建 GitHub Release。

一次性配置（本仓库已配置，2026-11-08）：仓库 Settings → Secrets and variables → Actions 添加
`NPM_TOKEN`（npm 网站 → Access Tokens → Granular，权限 `read-write`，仅限本包）。`--provenance`
要求 workflow 有 `id-token: write` 权限（已在 `release.yml` 声明）。

本地手动发布（CI 不可用时）：`npm login` 后 `npm publish --access public --otp=<6 位码>`。

## 回滚

npm 不允许删除已发布的版本（72 小时内可 unpublish，之后只能 deprecate）。线上问题发新的
patch 版本，不要依赖撤回；确需标记废弃用
`npm deprecate dsh-motrix@0.0.2 "contains a regression in the download wait loop; use 0.0.1 or 0.0.3"`。
