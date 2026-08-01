# Issue #10：小红书工具账号原会话安全验证入口

## 状态

- Issue：[#10](https://github.com/LuzernRR/agent-workbench/issues/10)
- Issue 状态：`ready`
- Execution Gate：`allowed`
- 当前交付状态：`accepted_with_deferred_live_scan`
- 目标环境：本机 3000 / 8080 与 `https://luzern.cc.cd`

本记录只覆盖“小红书工具账号触发安全验证后，向当前 Run 的用户提供真实可用入口并
保持后台等待”这一可靠性修复。HarnessRunner、LangSmith、LangGraph 图级并行归并等
均不在本轮范围内。

## 用户可验收目标

1. 平台要求安全验证时，Workbench 显示“立即验证”，链接进入当前工具账号会话的
   二维码页，而不是普通小红书首页。
2. 不要求管理员权限；只有拥有该 Run 的当前匿名访客可以读取状态和二维码。
3. 验证期间原 Run 保持等待并轮询，不重复调用模型或搜索。
4. 验证成功后原搜索最多重试一次；取消、超时、账号不一致或服务异常时结构化降级。
5. 二维码、Cookie、token、`xsec_token`、base64 和内部服务地址不进入持久事件或 UI。

## 根因证据

真实浏览器 DOM 诊断得到两种不同结果：

- 注入工具当前 Cookie 的浏览器进入 `/website-login/captcha`，页面含 `.qrcode-img`、
  `.qrcode-container` 和一张 `data:image/png` 二维码。
- 无 Cookie 浏览器进入 `/website-login/error`，只有“安全限制”，没有二维码。

旧实现搜索遇到 CAPTCHA 后关闭原登录态浏览器，再通过 `WithoutCookies()` 创建新会话
获取二维码。因此验证请求虽真实发生，却与工具账号会话脱离，最终只能返回
`VERIFICATION_QRCODE_UNAVAILABLE`。

## 实现

### MCP 原会话绑定

- 搜索请求携带 `verification_request_key = runId:toolCallId`。
- Go 服务遇到 `CAPTCHA_REQUIRED` 时从只读池中 detach 当前 page/browser，按 request
  key 暂存 45 秒，不关闭、不导航、不创建匿名浏览器。
- `StartLoginVerification` 只消费精确匹配的暂存会话；无匹配会话返回
  `VERIFICATION_SESSION_UNAVAILABLE`，错 key 不会消耗原会话。
- `FetchCurrentVerificationQrcode` 只在当前 `/website-login/captcha` 页读取 PNG data
  URL；不导航首页。
- 扫码完成后核对当前账号 ID，匹配后才保存 Cookie；原搜索只重试一次。
- 验证页进入错误状态时立即转为 `VERIFICATION_FAILED`，不再无意义等待四分钟。

### Run、API 与 UI

- Search Agent 将挑战短期绑定到 `runId/toolCallId`，二维码仍只保存在 MCP 内存中。
- `tool.verification.required` 将工具状态置为 `waiting`，Run 状态置为 `waiting`；轮询
  心跳不持久化为 UI 噪声。
- 验证链接为同源
  `/workbench/verify/xiaohongshu/{runId}/{challengeId}`。
- Next BFF 先按当前 HttpOnly visitor Cookie 查询 Run 所有权；不检查管理员角色。
- 二维码代理响应固定为 `image/png`、`Cache-Control: no-store`、
  `Content-Disposition: inline` 和 `X-Content-Type-Options: nosniff`。
- UI 只展示公开状态、倒计时、取消按钮和二维码，不显示内部 CAPTCHA URL、Cookie、
  token、base64 或私有思维链。

## 自动化验证

### Go

Docker builder 执行 `go test ./...` 并构建成功。新增覆盖：

- 原工具 page/browser 精确复用；
- 无暂存会话和错 request key；
- pending 幂等；
- 账号匹配后保存、账号不一致 fail-closed；
- 超时、取消和验证页失败；
- 二维码不进入公开 JSON。

### Search Agent

```text
202 passed in 11.17s
Ruff: All checks passed
compileall: passed
```

定向的 MCP/验证 API/Registry/Graph 测试为 `80 passed`，覆盖 CAPTCHA → 挑战 → 轮询 →
原搜索单次重试，以及跨 Run 拒绝和 PNG no-store。

### Web

```text
Vitest: 374 passed, 1 skipped
typecheck: passed
lint: passed
production build: passed
3110 Playwright: 16 passed, 3 skipped
git diff --check: passed
```

## 生产部署与真实入口证据

- `xiaohongshu-mcp` 部署版本：`v2.2.6-agent-workbench.5`
- Compose 七项服务：全部 healthy
- `http://127.0.0.1:3000/health`：200
- `http://127.0.0.1:8080/health`：200
- `https://luzern.cc.cd/workbench`：200
- Web、Search Agent、MCP 最近日志未见 ERROR、Traceback、panic 或 fatal。

公网使用用户固定提示词创建真实运行
`run_3f55a761a0794dcf8eda1b728a2bae9b`：

- 5.876 秒出现“立即验证”；
- href 严格匹配当前 `runId` 与 43 字符高熵 challenge；
- 同一访客打开验证页后，二维码响应 200；
- Content-Type 为 `image/png`；
- Cache-Control 为 `no-store`；
- 响应 6166 字节且 PNG signature 有效；
- 测试挑战立即 DELETE 取消，Run 随后停止，未占用四分钟验证锁；
- PostgreSQL 中该 Run 的持久 payload 对
  `base64|cookie|xsec_token|reasoning_content|18060` 扫描计数为 0。

自动化 Run 的匿名 Cookie 只存在于测试浏览器，不能拿它的链接要求用户在另一个浏览器
扫码。因此该挑战已取消，不作为人工验收入口。

## 用户验收与保留风险

用户于 2026-08-01 明确回复“通过，先不管小红书”，接受当前验证入口与受控等待实现，
并要求继续后续 Agent 运行框架开发。用户选择暂不执行以下真实扫码后的恢复门禁：

- 同一 Run 从 `waiting` 回到 `running`；
- 原 MCP 查询只重试一次；
- 至少读取 3 条真实、相关、可访问的
  `https://www.xiaohongshu.com/explore/...` 正文 Evidence；
- 最终按用户要求输出 3–5 条经验且不把个人体验写成医疗建议；
- 正文不可读的候选不进入证据。

因此本记录不宣称已经证明扫码成功后的正文恢复结果；该外部平台保留风险经用户明确
接受，不再阻塞本 Issue 的 stage、commit、push、close 与下一 feature。
