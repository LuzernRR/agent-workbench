# 项目交接

## 交接结论

- 仓库：`LuzernRR/agent-workbench`
- 默认分支：`main`
- 运行端口：`3100`
- 前端目录：`frontend`
- 本地密钥：`config/agent-runtime.local.json`，禁止提交
- 当前开发模式：单功能、单 Issue、单开发记录、用户验收后再继续

## 已验证能力

- DeepSeek V4 Flash、V4 Pro 公开模型配置。
- 浏览器发送消息、Next 服务端调用、DeepSeek SSE、AgentEvent、逐字回复完整闭环。
- 会话新建、重命名、移动、删除与项目树展示。
- 流式停止、附件上传、审批演示、计划、成果、文件、代码、日志工作区。
- 桌面、窄屏、移动端布局。
- 密钥不进入公开模型接口、客户端源码和构建文件。

## 当前真实边界

| 领域 | 当前实现 | 接手时不得误判 |
|---|---|---|
| 数据 | `src/server/mock/store.ts` 进程内 Map | 不是持久化，重启服务后数据丢失 |
| 模型 | DeepSeek 真实接口 | 模型回复真实，工具事件不一定真实 |
| 工具 | `scripts.ts` 测试脚本 | 搜索、抓取、RAG、代码执行尚未接真实工具 |
| 附件 | 进程内字节与文本上下文 | 图片未作为多模态内容发给模型 |
| 记忆 | 文档设计与日志演示 | 未接 PostgreSQL、pgvector、检查点 |
| 认证 | 本地单用户 | 无账号、租户、权限隔离 |

## 用户已报告且尚未处理

1. 新建项目输入框存在重叠和选中感。
2. 项目需要长按拖动、动效以及拖入拖出。
3. 图片附件只显示图像，不显示文件名。
4. 助手回复去掉“智能助手”。
5. 模型选择展示真实模型名称。
6. 所有演示数据替换为真实数据。
7. 项目、会话、消息、运行和附件持久化。
8. 切换会话与刷新页面时消除闪屏。
9. 顶栏项目与会话层级、筛选逻辑修正。
10. 实现第一个万能搜索 Agent。

## 建议验收顺序

每一项单独建立 Issue，上一项未获用户验收不得执行下一项。

1. 新建项目对话框视觉修复。
2. 顶栏项目与会话显示规则。
3. 图片附件展示规则。
4. 回复身份与真实模型命名。
5. PostgreSQL 持久化基础与数据迁移。
6. 会话切换、刷新恢复与闪屏治理。
7. 项目长按拖拽与跨层级移动。
8. 万能搜索 Agent：搜索、抓取、重排、引用、验证。

## 下一项默认范围

### 功能 1：新建项目对话框视觉修复

- 修复输入框、标签、占位符和焦点环重叠。
- 去掉持续性的“已选中”外观，只在键盘焦点时显示克制焦点态。
- 不改变项目 API、树结构、拖拽和持久化。
- 覆盖桌面、窄屏和移动端截图。
- 用户验收后才进入顶栏显示规则。

## 核心代码路径

- 工作台壳层：`frontend/src/components/workbench/app-shell/WorkbenchShell.tsx`
- 项目与会话树：`frontend/src/components/workbench/sidebar/WorkbenchSidebar.tsx`
- 输入与模型：`frontend/src/components/workbench/composer/AgentComposer.tsx`
- 对话渲染：`frontend/src/components/workbench/conversation/Conversation.tsx`
- 前端流状态：`frontend/src/hooks/use-agent-thread.ts`
- 事件协议：`frontend/src/lib/agent-events/`
- DeepSeek 客户端：`frontend/src/server/llm/deepseek-client.ts`
- 运行编排：`frontend/src/server/mock/engine.ts`
- 当前内存存储：`frontend/src/server/mock/store.ts`
- 统一配置：`frontend/src/server/config/runtime-config.ts`

## 开发前检查

```powershell
git status --short
git pull --ff-only
cd frontend
npm test
npm run typecheck
npm run lint
```

## 交付前检查

```powershell
cd frontend
npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

还需要针对当前 Issue 补充真实浏览器操作、截图、控制台错误和接口证据。
