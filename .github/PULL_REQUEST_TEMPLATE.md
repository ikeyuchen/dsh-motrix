## 改了什么

<!-- 一句话说明；关联 issue 写 Fixes #123 -->

## 为什么

## 自检

- [ ] `npm test` 通过（契约 + tarball 发布边界）
- [ ] `npm run release:check` 通过；动了工具描述/参数时附 `npm run tokens` 前后数字
- [ ] AI 生成的注释/文档/文案已按 `AGENTS.md`「AI 生成内容」逐条对照实现核对
- [ ] 新增文件已加进 `package.json` 的 `files`
- [ ] 模型可见契约（工具名 / 参数 / 枚举）有变化时，按 `docs/RELEASING.md` 标注版本位
- [ ] CHANGELOG 已按「新增功能 / 体验优化 / 问题修复 / 其他变更」补条目（仅发版提交）
