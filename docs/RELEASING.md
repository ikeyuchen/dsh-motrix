# 发布流程

## 版本策略（0.0.x）

对外首发为 0.0.1。版本号只沿 `0.0.x` 递增（0.0.1 → 0.0.2 → …），不使用 `0.x.0` minor 位。

| 变更 | 版本位 | 例子 |
|---|---|---|
| 修 bug、改文档、改文案 | **0.0.x** | 修正停滞检测提示 |
| 模型可见契约变化 | **0.0.x** | 加/改名工具、参数、枚举 |
| 契约稳定后 | 1.0.0 | — |

工具描述与参数说明占每请求常驻 token；改完运行 `npm run release:check`（预算 tokA ≤ 460）。

## Beta 预发布

beta 用于上线前验证，不影响稳定版：

```bash
npm version prerelease --preid beta --no-git-tag-version   # 0.0.x → 0.0.x-beta.N
# 同步 README「当前 **x.y.z**」与 CHANGELOG，运行 npm run release:check
git tag v<version> && git push origin main --tags
```

`release.yml` 在版本号含 `-` 时自动 `npm publish --tag beta`，`latest` 不变；安装 beta 用
`dsh plugin add dsh-motrix@beta`。转正时发布不带 `-` 的 patch 版本，CI 发回 `latest`。
刚发布完 `@beta` 可能仍解析到上一版（pnpm `minimumReleaseAge`），此时用精确版本号安装。

## 发布前检查

静态项由 `prepublishOnly` 执行 `npm run release:check`：包元数据、`files` 清单、组合包行与包名、
locale 元数据、CHANGELOG 与 README 版本、token 预算、单工具、无运行时 `dependencies`、无旧包名与
本机盘符残留。

动态项按 `AGENTS.md`「命令」在本地执行：`npm test`、`npm run tokens`、`npm run selftest`、
`npm pack --dry-run`。

发布前确认目标版本未发布：`npm view dsh-motrix@<version>` 应返回 404。

## 发布

```bash
# 1) 更新 CHANGELOG 与 README 版本，运行 npm run release:check
# 2) 合成本地未推送的提交（发布版本允许 fix + release 两个提交）
git reset --soft origin/main
git add -A && git commit -m "chore(release): v<version>"
# 3) 打 tag 推送
git tag v<version>
git push origin main --tags
```

`release.yml` 在 tag 推送后执行：`npm ci` → `npm test` → 校验 tag 等于 `package.json.version` →
`npm publish --provenance`（`prepublishOnly` 再跑 `release:check` 与 `npm test`；版本含 `-` 发
`beta`，否则发 `latest`）→ 创建 GitHub Release。

一次性配置（已配置）：仓库 Actions secrets 添加 `NPM_TOKEN`（Granular token，`read-write`，仅限本包）。
`--provenance` 要求 workflow 具有 `id-token: write` 权限。

本地手动发布（CI 不可用时）：`npm login` 后稳定版执行 `npm publish --access public --otp=<6 位码>`；
预发布需加 `--tag beta`。

## 发版验收

按 `AGENTS.md` 的「发版验收」执行：以 npm 源安装到本机 profile，验证 npm spec、真实 Motrix 的
`tasks` / `download` / `manage` 与守卫，再复核 tarball 与 npm 页面。

## 回滚

npm 不允许删除已发布版本（72 小时内可 unpublish，之后只能 deprecate）。线上问题发布新的 patch
版本；确需标记废弃：`npm deprecate dsh-motrix@<version> "<reason>; use <version>"`。
