# 安全图片输入能力协商与上线核验

## Issue 与目标

- Issue：[ #9 Agent 公开过程流式展示、有效来源增量与生产域名切换 ](https://github.com/LuzernRR/agent-workbench/issues/9)
- Status：`ready`
- Execution Gate：`allowed`
- 当前 Codex 目标：持续交付“平台万能搜”的真实场景多渠道搜索、流式公开过程、
  记忆/工具/Milvus 与安全多模态能力，并持续自审和上线核验。
- Git 边界：本记录对应改动未 stage、commit、push 或关闭 Issue；持续在同一功能边界内。

## 交付内容

### 图片能力协商

- 每个模型在服务端统一运行配置中有 `capabilities.imageInput` 开关，缺省值为
  `false`；当前 DeepSeek 模型保持该值，因此不会声称已经识读用户图片。
- 新增 `apps/web/src/server/media/image-input.ts`：只接受 PNG、JPEG、WebP、GIF，
  校验声明 MIME 与文件魔数、10 MiB 文件上限、4 张/轮上限、40 MP 像素上限，并在
  服务端计算 SHA-256。
- BFF 内部只保留 `PreparedImageInput` 的 bytes；对 Search Agent 的 JSON 请求只发送
  `attachmentId`、`mimeType`、`sizeBytes`、`sha256`。没有 base64、图片 URL 或私有
  Provider URL 进入 AgentEvent、日志或跨服务请求。
- Search Agent 的 Pydantic 内部 API 以严格 `ImageInputReference` 接收这份最小引用，
  会拒绝 SVG、伪造摘要、URL、base64 与未知字段。
- 当用户上传图片时，当前模型收到的上下文会明确说明“图片内容未发送给模型、搜索
  工具或作为回答依据”。即使未来误把模型能力开关设为 `true`，在真正的视觉 adapter
  接入前也保持 `adapter_unavailable` 的 fail-closed 行为。
- 已预留 `toProviderImageContent()` 作为未来仅服务端视觉适配器的内容构造接缝；
  视觉/OCR Provider 接入时必须继续使用当前 MIME、体积、像素、哈希和无敏感日志
  边界，不能直接把浏览器 URL 或原始附件事件交给模型。

### 真实运行链路

`上传附件 → PostgreSQL 私有 bytes → BFF 安全准备/能力协商 → 最小图片引用 →
Search Agent 严格契约 → LangGraph 搜索循环`

当前的最后一步不会消费图片内容；图片不会变成搜索来源、核验事实或回答依据。未来
视觉适配器可在协商成功后于 BFF 服务端接入，不需要改变浏览器事件协议。

## 验证与部署

- Web 定向：4 文件、23 项测试通过；目标 ESLint 与 `npm run typecheck` 通过。
- Search Agent 定向：16 项通过；Ruff 与 `compileall` 通过。
- 全量 Search Agent：`146 passed`，Ruff、compileall 通过。
- 全量 Web：`351 passed, 1 skipped`，typecheck、全量 ESLint、生产 build 通过。
- Playwright：干净的 3110 mock 服务 `16 passed, 2 skipped`。首次运行发现 3110
  被前一日遗留的 `next start` 占用，Playwright 复用了非 mock 服务并得到列表 404；
  仅停止该明确的测试 PID 后，按配置重启 mock 服务，所有非 live 场景通过。
- Compose 使用 `config/deploy.local.env` 重新构建并更新了
  `xiaohongshu-mcp`、`search-agent`、`web`；PostgreSQL、Milvus 数据卷和配置没有
  被删除或迁移。
- 上线后健康检查：`http://127.0.0.1:3000/health` 为 200，
  `http://127.0.0.1:8080/health` 为 200，Milvus 为 enabled/available；
  [https://luzern.cc.cd/workbench](https://luzern.cc.cd/workbench) 为 200，页面标题为“平台万能搜”。

## 回滚

将 `search-agent` 与 `web` 恢复到先前镜像即可；图片引用不改数据库 schema，也不
会向事件账本写入 bytes，因此不会遗留需要数据回滚的敏感多模态内容。
