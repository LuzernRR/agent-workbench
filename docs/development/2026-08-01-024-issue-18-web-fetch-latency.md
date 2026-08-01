# Issue #18：Web 正文读取延迟与部分成功可靠性

## 范围

本 Issue 只优化通用 Web 渠道从候选 URL 读取公开正文的延迟与单页失败隔离。不修改
Supervisor、Planner、Tavily Key、小红书、Evidence 状态机、HarnessRunner 或前端自然语言。

## 生产基线与根因

Issue #17 使用首页奖学金案例的生产运行中，两个 Web 工具分别耗时 75.055 秒和 84.501 秒，
整轮 103.334 秒，其中一个工具最终因 `RUN_TIME_RESERVE` 失败。

旧抓取器存在两个叠加等待：

1. `_fetch_static` 可先为 robots 等待最多 10 秒，再为正文请求等待最多 20 秒；传入的 20 秒并非
   单页总 deadline；
2. `fetch_pages` 的全局并发为 3，但同一域名的 semaphore 固定为 1。搜索结果若前三项来自同域，
   三页会完全串行，最坏接近 90 秒。

外层工具 timeout 在整个 `gather` 外部生效，一个慢页面可能取消完整工具调用，即使同批其他页面
已经读到正文也无法交付。

## 修改

### 单页总 deadline

`fetch_page` 现在使用 `asyncio.timeout` 包住完整静态/动态流程。传入的 20 秒同时覆盖：

- robots 检查；
- DNS 解析与 SSRF policy；
- 固定公网 IP 连接；
- 每次重定向重新校验；
- 响应体读取、正文抽取与可选动态降级。

单页超过总时限会返回 `ok=false / error_category=timeout`，错误文案为公开稳定的
“抓取超过单页总时限”。该异常只属于当前页；`fetch_pages` 仍按输入顺序返回每页结果，其他成功
正文不会丢失。外部取消不是内部 deadline，`CancelledError` 继续传播给 HarnessRunner。

### 有界同域并发

新增明确常量：

- `MAX_FETCH_CONCURRENCY = 3`；
- `MAX_PER_DOMAIN_CONCURRENCY = 2`。

调用方即使传入更高 concurrency，也会被全局硬上限夹到 3；同域最多同时读取 2 页。三个同域
候选因此按 2+1 批次执行，不再完全串行；concurrency=1 时同域上限也自动保持 1。

安全边界没有变化：仍先执行 URL policy，固定已校验公网 IP，同时保留原 Host 与 TLS SNI；每次
重定向重新执行 robots 和 URL 校验；非文本内容、超大响应、内网地址与未隔离动态浏览器继续
fail-closed。

## 测试

新增 5 个确定性测试：

1. 三个同域 URL 的实际峰值并发为 2，第三个只在前两个之一结束后启动；
2. 五个不同域 URL 的全局峰值并发为 3，即使调用方请求 20；
3. 单页总 deadline 能中止跨阶段的慢静态流程；
4. 一页超时时，同批两页正文仍完整返回；
5. 外部 task cancel 继续抛出 `CancelledError`，不转成页面 timeout。

完整门禁：

- Search Agent：247 passed；Ruff 与 compileall 通过；
- Python 合同：6 passed；
- Web：381 passed、1 skipped；typecheck、lint、production build 通过；
- Playwright 首轮在流式滚动按钮等待上发生一次非本功能时序失败；该用例单独复跑 1 passed，
  随后全量复跑 16 passed、3 个 live gate skipped；
- `git diff --check` 通过。

## 生产对比

`run_issue18_scholarship_1785583215521` 使用与 #17 完全相同的首页奖学金提示词：

- 整轮 80.359 秒，对比 103.334 秒减少 22.975 秒；
- Web 工具一：44.462 秒，对比 75.055 秒减少 30.593 秒；
- Web 工具二：58.565 秒，对比 84.501 秒减少 25.936 秒；
- 两次工具调用均有真实 terminal；第二次保留 5 个候选和 3 条已读正文 Evidence；
- 0 node.failed；公开事件禁止字段扫描为 0；
- 回答没有防晒、肤质、个人体验或医疗建议等领域污染。

首个查询由外部 Provider 返回零候选，现有三条 Evidence 只覆盖 Chevening 且当前周期已关闭，
不满足用户“仍可申请”的硬条件。因此运行正确以 `RUN_TIME_RESERVE / partial` 收口，没有利用延迟
优化掩盖证据不足，也没有把搜索 snippet 当正文。

## 部署与回滚

- 回滚镜像：`agent-workbench/search-agent:pre-issue-18-df143b3`；
- 只滚动替换 Search Agent，Web、PostgreSQL、Milvus、小红书会话和用户数据未修改；
- Compose 七服务 healthy；3000、8080 与
  [https://luzern.cc.cd/workbench](https://luzern.cc.cd/workbench) 均为 200；
- 回滚只切换 Search Agent 镜像，不删除 checkpoint、工具账本、Evidence 或会话数据。
