# 安全策略

## 报告漏洞

请不要在公开 issue 里贴漏洞细节。使用 GitHub 的私密报告通道：

<https://github.com/ikeyuchen/dsh-motrix/security/advisories/new>

请附上受影响的版本、复现步骤、影响范围（例如能否绕过下载守卫、能否把参数注入 CLI
argv、是否会泄漏桥接 token），以及你建议的修复方向。确认后会给出修复计划与致谢方式。

## 支持范围

当前只有 0.0.x 系列在维护；修复进入新的 patch 版本，不回补旧版本。

## 本插件涉及的边界

- **下载守卫**只拦 shell 工具里「下载器 + 明确落盘」的窄组合（`curl -o`、`wget -O`、
  `aria2c`、`Invoke-WebRequest -OutFile`、`Start-BitsTransfer`、重定向落盘、大文件后缀
  URL），用途是把模型引导到 `motrix` 工具，**不是安全沙箱**。
- **命令行注入**：所有拼进 `motrix` argv 的调用方取值都做过校验（禁止以 `-` 开头等），
  代理 URL 走协议白名单；子进程不经过 shell。
- **凭据**：桥接 token 只通过环境变量与 HTTP 头传给子进程/桥接，不打印到日志或工具输出。
- **删除保护**：`action=manage` 的 `remove` 在 `deleteFiles: true` 时会核对文件是否仍是
  当初那次下载产生的，不符就只删任务记录。
