# 阶段 1 实施清单

## 交付边界

本清单对应 [Issue #2](https://github.com/LuzernRR/agent-workbench/issues/2)。全部子项属于一个验收批次；自动验证、文档、提交和推送完成后必须停止，等待用户验收。

## 1. 身份、数据库与路由

- [x] 统一配置加入 PostgreSQL、匿名会话与保留参数。
- [x] 增加 `pgvector/pgvector:pg17` 容器、健康检查和持久卷。
- [x] 幂等创建访客、项目、会话、项目记忆、运行、事件和附件表。
- [x] Proxy 首次页面访问签发 256 位随机 `HttpOnly` Cookie。
- [x] 数据库只存 Cookie SHA-256；live API 全部按访客隔离。
- [x] live 与 mock 分流；live 不读取种子或脚本工具。
- [x] 增加 `/workbench/p/{projectId}` 与 `/workbench/t/{threadId}`。
- [x] 刷新、直达和服务重启后恢复持久会话。

## 2. 活动分支与真实运行

- [x] 用户消息、Provider delta、完成状态和用量写入 PostgreSQL。
- [x] SSE 先补发持久事件，再订阅当前 runtime。
- [x] SSE 断开只移除订阅者，不取消模型运行。
- [x] 编辑消息时事务归档目标运行、下游运行、事件与项目记忆。
- [x] 浏览器提交编辑后立即截断本地旧分支。
- [x] 回复去掉 Agent 名称；live 工具目录为空。
- [x] 服务启动恢复时把中断运行标记失败并记录原因。
- [x] 收到真实 `runId` 前不显示停止按钮，显示后必有可取消运行。
- [x] 同一运行通过事件尾链串行持久化，取消后排队事件不再写入。
- [x] 停止、完成和失败通过条件更新原子抢占唯一终态，重复停止幂等返回实际状态。
- [x] 完成消息、项目记忆与完成终态同事务；停止运行不写项目记忆。

## 3. 导航、视觉与附件

- [x] 左栏项目为树节点，所属会话放在项目子树。
- [x] 无项目会话不显示“独立会话”等重复标题。
- [x] 会话单行裁切，不显示三个点或省略号字符。
- [x] 空项目和空会话列表不渲染说明占位文案。
- [x] 新建项目输入去掉重叠边线、焦点框和持续选中感。
- [x] 输入、按钮、菜单和消息编辑器无矩形焦点闪变。
- [x] 图片附件只显示图像；文档附件保留名称。
- [x] 模型菜单显示真实名称和 ID，打开时名称不重复。
- [x] 顶栏项目名与会话名拆成两个独立点击目标。
- [x] 项目视图只显示项目；会话视图按数据库归属显示。
- [x] 右栏可收起，状态跨路由保持。
- [x] 切换与刷新使用稳定壳层和结构骨架，不回放旧会话。

## 4. 直接拖拽

- [x] 接入 `@dnd-kit/core` 与 `@dnd-kit/sortable`。
- [x] PointerSensor 采用 3 像素移动阈值，无长按等待。
- [x] 项目排序写入 `sort_order`。
- [x] 会话可拖入项目、跨项目移动和拖出到无项目区。
- [x] 拖动位移、落点高亮、DragOverlay 与失败回滚完整。
- [x] mutation 乐观更新缓存，成功后服务端顺序为真值。

## 5. 项目记忆与保留

- [x] `wb_project_memories` 按访客与项目隔离。
- [x] 成功运行保存用户问题和助手回复。
- [x] 只召回同项目、非当前会话、未归档记忆。
- [x] 记忆作为不可信事实背景进入独立 system message。
- [x] 编辑、删除、移出和跨项目移动同步处理记忆。
- [x] 每项目按 `maxItems` 限量，Prompt 按 `recallItems/maxChars` 限界。
- [x] 3 天未活动且非运行会话自动删除。
- [x] 运行、事件、附件随会话级联，项目记忆独立有界保留。

## 6. 输出、滚动与页面生命周期

- [x] Prompt 按内容选择表格、步骤、列表或短段落。
- [x] GFM 表格在移动端内容区内部滚动，不撑宽页面。
- [x] 删除每个事件强制滚动到底部的 effect。
- [x] 用户上滚后暂停跟随，点击底部按钮才恢复。
- [x] 使用自适应渲染队列，长回复和终态快速收敛。
- [x] 页面隐藏时 flush 未渲染 delta，本轮后续事件直接追平。
- [x] 页面关闭和 SSE 断开后服务端继续读取模型并落库。

## 7. 验证与交接

- [x] 单元覆盖身份、配置、schema、Reducer、渲染队列、项目记忆和 Prompt 策略。
- [x] Playwright 覆盖刷新、URL、编辑、拖拽、图片、模型、焦点、空导航、滚动、后台输出和幂等停止。
- [x] 真实 DeepSeek 验证模型 ID、SSE、结构化表格和项目记忆隔离。
- [x] 真实 PostgreSQL 验证 3 天清理与外键级联。
- [x] 真实浏览器验证 Cookie、URL、刷新文字采样和控制台零错误。
- [x] 更新 `README.md`、`HANDOFF.md`、研究、实施、进度和中文开发记录。
- [x] 最终完整执行测试、类型、Lint、构建、E2E 和安全扫描。
- [ ] 提交并推送 `main`，把证据写入 Issue #2。
- [ ] 等待用户明确验收阶段 1。

## 关键文件

| 领域 | 文件 |
|---|---|
| 匿名 Cookie | `frontend/src/proxy.ts`, `frontend/src/server/session/visitor.ts` |
| PostgreSQL | `frontend/src/server/persistence/database.ts`, `frontend/src/server/persistence/schema.ts` |
| live API | `frontend/src/server/live/handler.ts` |
| 运行与后台 | `frontend/src/server/live/engine.ts`, `frontend/src/server/llm/deepseek-client.ts` |
| 数据与记忆 | `frontend/src/server/live/store.ts`, `frontend/src/server/live/prompt-policy.ts` |
| URL 选择 | `frontend/src/components/workbench/entry/WorkbenchEntry.tsx`, `frontend/src/app/workbench/` |
| SSE 与追平 | `frontend/src/hooks/use-agent-thread.ts`, `frontend/src/lib/agent-events/typewriter-queue.ts` |
| 对话与滚动 | `frontend/src/components/workbench/conversation/Conversation.tsx` |
| 侧栏拖拽 | `frontend/src/components/workbench/sidebar/WorkbenchSidebar.tsx` |
| 顶栏与面板 | `frontend/src/components/workbench/app-shell/WorkbenchShell.tsx` |
| 输入与模型 | `frontend/src/components/workbench/composer/AgentComposer.tsx` |
