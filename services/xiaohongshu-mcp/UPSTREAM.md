# xiaohongshu-mcp 受控服务副本

- 上游：`xpzouying/xiaohongshu-mcp`
- 许可证：Apache-2.0，完整文本见 `LICENSE`
- 基线提交：`a5bb5b872b1670e8ce557c1942c149f74dfd8246`
- 基线镜像：v2.2.6 linux/amd64，
  `sha256:9dd7a45d87dc6e209f0aaa53986e0d7b34ab837b49d767452adf42edc153bd2a`
- 当前项目部署版本：`v2.2.6-agent-workbench.5`

本副本只为项目内的受控只读服务构建保留运行所需源码。项目补丁仅移除
搜索页的全局 `network-idle` 等待，改为等待
`window.__INITIAL_STATE__.search.feeds` 的数组真正写入至少一条结果；部署版只
注册五个只读 MCP 工具和对应 HTTP 路由，HTTP panic 统一返回无原始错误正文的
稳定 500；MCP 工具 panic 只记录错误类型并返回固定文字，不记录原始值或堆栈。
导航日志不记录带签名 URL。没有加入代理、验证码绕过、发布、评论、点赞或
收藏能力。遇到平台安全验证时，`.5` 只保留触发风控的原工具浏览器会话，
从该会话当前 CAPTCHA 页读取二维码并等待扫码；不会新建匿名浏览器或把普通
小红书页面作为验证入口。

对外安全边界仍由 `services/search-agent` 的只读 Adapter 与 Docker 网络策略
执行。升级上游时必须重新核对许可证、提交、镜像 provenance、路由和补丁。
