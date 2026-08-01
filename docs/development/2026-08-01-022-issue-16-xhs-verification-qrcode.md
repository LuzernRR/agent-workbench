# Issue #16：小红书工具会话安全验证二维码竞态

## 范围

本 Issue 只修复小红书只读搜索触发 `CAPTCHA_REQUIRED` 后，原隔离工具会话偶发无法生成
二维码的问题。不修改搜索意图、Evidence 状态机、记忆或 HarnessRunner。

## 真实复现

生产工具账号 `/api/v1/login/status` 返回已登录。使用“油敏皮夏季通勤防晒”发起真实只读搜索：

- 0.8 秒返回 `CAPTCHA_REQUIRED`；
- 服务成功 detach 并保留触发风控的原 page/browser；
- CDP 只读结构检查确认页面为 `/website-login/captcha`，标题为“安全验证”；
- 页面存在一张 `qrcode-img`，是 176×176 的 data PNG；
- 但紧接着 `POST /api/v1/login/verification` 偶发约 10 秒后返回
  `VERIFICATION_QRCODE_UNAVAILABLE`。

因此，问题不是 Workbench 打开了普通小红书首页，也不是页面没有二维码，而是服务端获取
二维码的时序错误。

## 根因与修改

旧顺序为：

1. 取走原 CAPTCHA 隔离会话；
2. 启动另一个只读浏览器，导航并确认持久工具账号；
3. 回到原 CAPTCHA 页面读取二维码。

第二步包含真实页面导航和账号状态解析，可能消耗数秒。安全验证二维码是短时页面状态，延迟后
再读取会错过可用窗口，并且失败会关闭原隔离会话，用户无法重试。

`StartLoginVerification` 现在先从原隔离 page/browser 捕获二维码并校验 PNG，再通过独立登录态
确认预期账号。二维码在账号确认前只存在于函数局部内存；只有账号已登录且有稳定 user ID 后才
建立 43 位 challenge。账号失效、ID 缺失、账号不一致或 PNG 无效仍 fail-closed。

新增测试会让二维码在账号解析发生时立即失效，并断言调用顺序必须是 `qrcode -> account`。
这直接覆盖生产竞态，而不是只检查错误码文案。

## 扫码与真实正文结果

用户扫描了与原 CAPTCHA 工具会话绑定的二维码。该手工 challenge 在用户确认时已到 4 分钟
截止边界，后端最终记录 `VERIFICATION_TIMEOUT`；本记录不把它伪造成 `succeeded`。扫码后平台
风险状态已解除，后续真实调用不再返回 CAPTCHA。

部署修复镜像后再次执行同词验证：

- 搜索 3.7 秒返回 20 个候选；
- 连续读取前 5 篇可用详情，5/5 成功；
- 标题包括“油敏皮防晒决赛圈”“油敏皮攻略（广东版）”和“不是最清爽就好！油敏皮防晒按场景
  抄作业”；
- 正文长度分别为 16、99、1032、32、662 字；
- 0 CAPTCHA，0 detail error。

平台当前不再触发安全验证，因此没有输出普通首页、其他账号二维码或伪造 challenge。

## 验证

- Xiaohongshu MCP：`go test ./...` 全量通过；Docker build 内再次全量通过；
- Search Agent：231 passed，Ruff、compileall 通过；
- Python 合同：6 passed；
- Web：381 passed、1 skipped，typecheck、lint、production build 通过；
- Playwright：16 passed、3 个 live gate skipped；
- `git diff --check` 通过。

## 部署与回滚

- 回滚镜像：`agent-workbench/xiaohongshu-mcp:pre-issue-16-8650bfc`；
- 仅滚动重建 `xiaohongshu-mcp`，其余服务未替换；
- 新容器 healthy；3000 与 `https://luzern.cc.cd/workbench` 返回 200；
- 回滚只需切回上述镜像，不删除 Cookie volume、数据库或任何用户数据。

## 后续发现

用户截图对应真实运行 `run_c0e55bd0d19646f19bceacbe092eb30b`。数据库公开事件显示输入确为
“你是谁”，但 Planner 首轮生成英国奖学金检索计划；Reflect 后来识别不相关，系统仍继续搜索
“你是谁 自我介绍”，Writer 最终以 Writer Agent 身份回答。这是当前消息意图与历史上下文隔离
错误，必须作为下一独立 Issue 修复，不能用硬编码身份文本或固定回复掩盖。
