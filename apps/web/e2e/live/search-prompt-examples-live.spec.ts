import { expect, test, type Page } from "@playwright/test";

test.skip(process.env.LIVE_SEARCH_E2E !== "1", "真实 Provider 验收需要显式开启");

type PromptExample = {
  readonly id: "web" | "xiaohongshu" | "x";
  readonly title: string;
  readonly prompt: string;
  readonly primaryChannel: string;
};

const examples: readonly PromptExample[] = [
  {
    id: "web",
    title: "学生 · 英国硕士奖学金",
    prompt: "请搜索 2026 年面向中国大陆本科生的英国授课型硕士奖学金与学费减免信息，优先阅读英国大学官网、British Council 和政府页面。筛选仍可申请的项目，按“学校 / 专业限制 / 金额或减免方式 / 申请截止日 / 适合人群 / 官方来源”整理；过期或二手转述不纳入结论。",
    primaryChannel: "web"
  },
  {
    id: "xiaohongshu",
    title: "女性通勤 · 油敏皮夏季防晒",
    prompt: "请搜索小红书上关于“油敏皮夏季通勤防晒”的近期使用笔记。只读取可访问正文，按“肤质与场景 / 使用感受 / 防晒产品类型 / 可能不适合的人群 / 来源链接”归纳 3–5 条经验；不得把个人体验写成医疗建议，正文不可读时不展示为证据。",
    primaryChannel: "xiaohongshu"
  },
  {
    id: "x",
    title: "求职学生 · AI 产品岗位动态",
    prompt: "请搜索 X 上近 90 天关于“AI 产品实习 / Agent 产品岗位”的公开讨论和招聘帖，优先读取可访问帖文正文。为准备求职的学生筛选 3–5 条，按“岗位或技能要求 / 原帖观点 / 对简历准备的启发 / 链接”整理；未读取正文的候选不得写入结论。",
    primaryChannel: "x"
  }
];

const requestedExampleId = process.env.LIVE_PROMPT_EXAMPLE;
const liveExamples = requestedExampleId
  ? examples.filter((example) => example.id === requestedExampleId)
  : examples;

if (!liveExamples.length) {
  throw new Error(`未知的 LIVE_PROMPT_EXAMPLE：${requestedExampleId}`);
}

function decodeSse(text: string) {
  return text.split(/\r?\n/u)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as {
      type: string;
      payload: Record<string, unknown>;
    });
}

async function createThread(page: Page, title: string) {
  const response = await page.request.post("/api/v1/threads", {
    data: { projectId: null, title }
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<{ id: string }>;
}

test("三张真实案例卡填充正确，并路由到对应的搜索渠道", async ({ page }) => {
  test.setTimeout(1_200_000);
  await page.goto("/workbench");
  await expect(page.getByRole("heading", { name: "今天想做什么？" })).toBeVisible();

  for (const example of liveExamples) {
    await page.goto("/workbench");
    await page.getByRole("button", { name: `填入案例：${example.title}` }).click();
    await expect(page.getByLabel("任务输入")).toHaveValue(example.prompt);

    const thread = await createThread(page, `真实案例-${example.id}-${Date.now()}`);
    await page.goto(`/workbench/t/${thread.id}`);
    await page.getByLabel("任务输入").fill(example.prompt);
    const runResponsePromise = page.waitForResponse((response) => response.request().method() === "POST"
      && /\/api\/v1\/threads\/[^/]+\/runs$/u.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const runResponse = await runResponsePromise;
    expect(runResponse.ok()).toBe(true);
    const { runId } = await runResponse.json() as { runId: string };

    await expect(page.getByRole("button", { name: "复制完整回复" })).toBeVisible({ timeout: 300_000 });
    const eventResponse = await page.request.get(`/api/v1/runs/${runId}/events?after=0`);
    expect(eventResponse.ok()).toBe(true);
    const events = decodeSse(await eventResponse.text());
    const types = events.map((event) => event.type);
    expect(types).toEqual(expect.arrayContaining([
      "thinking.started",
      "tool.started",
      "tool.progress",
      "message.delta",
      "run.completed"
    ]));
    const primaryTools = events.filter((event) => event.type === "tool.started"
      && event.payload.channel === example.primaryChannel);
    expect(primaryTools.length).toBeGreaterThan(0);
    const primaryCompletedTools = events.filter((event) => event.type === "tool.completed"
      && event.payload.channel === example.primaryChannel);
    const terminal = events.filter((event) => event.type === "run.completed").at(-1);
    expect(terminal).toBeDefined();
    if (terminal?.payload.responseStatus === "partial") {
      expect(terminal.payload.verificationPassed).toBe(false);
    } else {
      expect(primaryCompletedTools.some(
        (event) => Number(event.payload.evidenceCount || 0) > 0
      )).toBe(true);
    }
    const sourceText = events.filter((event) => event.type === "tool.source.delta")
      .map((event) => String(event.payload.delta || ""))
      .join("\n");
    expect(sourceText).not.toMatch(/(?:正文未读取|仅发现候选|未涉及|不适用|已过期)/u);
  }
});
