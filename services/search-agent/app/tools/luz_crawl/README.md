# Luz Crawl runtime adaptation

本目录适配自本机 `luz-crawl` 技能的 `tool_preflight.py`、source routing、
production crawler contract 与 provenance 设计，用于项目内可版本化的生产运行时。

只保留公开、免登录、只读的渠道预检与证据规则。以下能力明确没有复制：

- Codex 设备登录与任何设备认证；
- Cookie、浏览器 Profile、扫码登录和登录态导入；
- CAPTCHA、风控、登录墙或访问控制绕过；
- 任意 URL Reader 与未经过 SSRF/host/path 策略的下载器；
- X 收藏、私有内容和小红书会话绑定的原生后端。
