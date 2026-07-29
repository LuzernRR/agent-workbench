# 逐功能开发记录

## 规则

- 一个功能对应一个 GitHub Issue、一个开发记录和一次用户验收。
- 文件名使用 `YYYY-MM-DD-NNN-功能名.md`。
- 记录必须描述真实代码和真实验证，不复制需求，不隐瞒未实现项。
- 配置仅记录字段、路径和用途，不记录密钥值。
- 流程必须从入口写到状态落点，标出失败、取消、重试与恢复分支。
- 开发记录与功能代码同一提交，便于按提交恢复完整上下文。

## 必填证据

1. Issue、目标、范围、非目标和验收条件。
2. 修改前的真实行为与根因。
3. 架构决策、替代方案和取舍。
4. 逐文件修改说明。
5. 数据结构、接口、事件与状态流转。
6. 配置字段和安全边界。
7. 单元、类型、Lint、构建、端到端和运行态证据。
8. 未解决问题、回滚方式和下一功能门禁。

## 索引

- [阶段 0：公开仓库、文档与交接基线](2026-07-26-000-public-baseline.md)
- [阶段 1：真实会话连续性与工作台交互修复](2026-07-26-001-workbench-continuity.md)
- [阶段 2：动态模型身份与分层记忆契约](2026-07-26-002-model-identity-memory.md)
- [阶段 3：推理摘要与项目上下文](2026-07-26-003-reasoning-project-context.md)
- [共享搜索 Agent 合同](2026-07-26-004-search-agent-contracts.md)
- [前端 Agent 工作台：过程、引导与消息队列](2026-07-27-005-agent-frontend.md)
- [真实 LangGraph 多 Agent 搜索闭环与递增展示](2026-07-28-006-langgraph-search-agent.md)
- [LangGraph 自适应多渠道搜索 Agent](2026-07-29-007-multichannel-search-agent.md)
- [Agent 公开文段流式展示与有效来源增量](2026-07-29-008-streamed-process-effective-sources.md)
- [开发记录模板](TEMPLATE.md)
