export type ScriptToolStep = {
  kind: "tool";
  toolId: string;
  name: string;
  input: Record<string, unknown>;
  summary: string;
  output: string;
  durationMs: number;
  requiresApproval?: boolean;
  approvalTitle?: string;
  approvalDescription?: string;
};

export type ScriptPlanStep = { kind: "plan"; steps: Array<{ title: string; status: "todo" | "in_progress" | "done" | "blocked"; notes?: string }> };
export type ScriptLogStep = { kind: "log"; level: "debug" | "info" | "warn" | "error"; actor: string; content: string };
export type ScriptTextStep = { kind: "text"; chunks: string[] };
export type ScriptCitationStep = { kind: "citations"; items: Array<{ label: string; url: string }> };
export type ScriptArtifactStep = {
  kind: "artifact";
  name: string;
  artifactKind: "report" | "table" | "download";
  mimeType: string;
  content: string;
};
export type ScriptMemoryStep = { kind: "memory"; recalled: string[]; extracted: string[] };
export type ScriptFileStep = {
  kind: "file";
  name: string;
  path: string;
  language: string;
  content: string;
};

export type ScriptStep =
  | ScriptToolStep
  | ScriptPlanStep
  | ScriptLogStep
  | ScriptTextStep
  | ScriptCitationStep
  | ScriptArtifactStep
  | ScriptFileStep
  | ScriptMemoryStep;

function streamChunks(text: string): string[] {
  return text.split(/(?<=[。；！？\n）】]|, )/u).filter(Boolean);
}

function subjectOf(message: string) {
  const value = message.replace(/\s+/g, " ").trim();
  return value || "当前任务";
}

function responseFor(message: string, subject: string) {
  if (/代码|组件|函数|接口|页面|实现/u.test(message)) {
    return [
      `我已整理「${subject}」的实现草案。`,
      "",
      "## 实现路径",
      "",
      "1. 先固定输入、输出和错误状态",
      "2. 把核心逻辑与界面状态分开",
      "3. 为主流程、空状态和失败状态补测试",
      "",
      "```ts",
      "type TaskState = \"idle\" | \"running\" | \"completed\" | \"failed\";",
      "",
      "export function createTaskState(): TaskState {",
      "  return \"idle\";",
      "}",
      "```",
      "",
      "可以直接从最小闭环开始，再逐步加入扩展能力。"
    ].join("\n");
  }

  return [
    `我已完成「${subject}」的第一轮整理。`,
    "",
    "## 处理结果",
    "",
    "- 目标已经收敛为一个可执行主题",
    "- 主流程拆分为准备、执行、检查三个阶段",
    "- 关键结果会保留在当前会话中，便于继续追问",
    "",
    "## 下一步",
    "",
    "先确认优先级最高的结果，再继续补充细节和交付格式。"
  ].join("\n");
}

function artifactFor(subject: string, response: string): ScriptArtifactStep {
  return {
    kind: "artifact",
    name: "任务整理.md",
    artifactKind: "report",
    mimeType: "text/markdown",
    content: [
      `# ${subject}`,
      "",
      "## 当前结论",
      "",
      response,
      "",
      "## 状态",
      "",
      "- [x] 明确目标",
      "- [x] 完成初步处理",
      "- [ ] 根据反馈继续迭代"
    ].join("\n")
  };
}

function codeFileFor(subject: string): ScriptFileStep {
  return {
    kind: "file",
    name: "TaskPanel.tsx",
    path: "outputs/TaskPanel.tsx",
    language: "typescript",
    content: [
      "type TaskPanelProps = {",
      "  title: string;",
      "  completed: boolean;",
      "};",
      "",
      "export function TaskPanel({ title, completed }: TaskPanelProps) {",
      "  return (",
      "    <section aria-label={title}>",
      `      <h2>${subject.replace(/[{}<>]/g, "")}</h2>`,
      "      <p>{completed ? \"已完成\" : \"处理中\"}</p>",
      "    </section>",
      "  );",
      "}"
    ].join("\n")
  };
}

export function buildScript(message: string): ScriptStep[] {
  const subject = subjectOf(message);
  const response = responseFor(message, subject);
  const createsArtifact = /方案|报告|文档|总结|整理|规划|代码|组件|页面/u.test(message);
  const createsCodeFile = /代码|组件|函数|接口|页面|实现/u.test(message);
  const needsApproval = /运行代码|执行脚本|发布|提交|发送邮件/u.test(message);

  const steps: ScriptStep[] = [
    {
      kind: "plan",
      steps: [
        { title: "理解当前目标", status: "in_progress" },
        { title: "组织处理步骤", status: "todo" },
        { title: "生成可用结果", status: "todo" }
      ]
    },
    { kind: "log", level: "info", actor: "助手", content: `开始处理：${subject}` },
    {
      kind: "tool",
      toolId: "context_read",
      name: "上下文读取",
      input: { task: subject },
      summary: "已读取当前会话上下文",
      output: "当前消息、会话历史与附件索引已就绪。",
      durationMs: 520
    },
    {
      kind: "plan",
      steps: [
        { title: "理解当前目标", status: "done" },
        { title: "组织处理步骤", status: "in_progress" },
        { title: "生成可用结果", status: "todo" }
      ]
    }
  ];

  if (needsApproval) {
    steps.push({
      kind: "tool",
      toolId: "code_runner",
      name: "代码运行",
      input: { task: subject },
      summary: "受控任务执行完成",
      output: "执行完成，未发现运行错误。",
      durationMs: 880,
      requiresApproval: true,
      approvalTitle: "允许本次执行？",
      approvalDescription: "该步骤会运行受控任务。"
    });
  }

  steps.push(
    {
      kind: "plan",
      steps: [
        { title: "理解当前目标", status: "done" },
        { title: "组织处理步骤", status: "done" },
        { title: "生成可用结果", status: "in_progress" }
      ]
    },
    { kind: "text", chunks: streamChunks(response) }
  );

  if (createsArtifact) steps.push(artifactFor(subject, response));
  if (createsCodeFile) steps.push(codeFileFor(subject));

  steps.push({
    kind: "plan",
    steps: [
      { title: "理解当前目标", status: "done" },
      { title: "组织处理步骤", status: "done" },
      { title: "生成可用结果", status: "done" }
    ]
  });

  return steps;
}
