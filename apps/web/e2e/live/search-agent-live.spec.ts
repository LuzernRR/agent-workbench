import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIResponse, type Page } from "@playwright/test";

test.skip(process.env.LIVE_SEARCH_E2E !== "1", "真实 Provider 验收需要显式开启");

const forbiddenPublicText = /reasoning_content|authorization|apiKey|systemPrompt|toolArguments/iu;

async function postWithVisitorRetry(page: Page, url: string, data: Record<string, unknown>) {
  let response: APIResponse | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    response = await page.request.post(url, { data });
    if (response.status() !== 401) return response;
  }
  return response!;
}

function decodeSse(text: string) {
  return text.split(/\r?\n/u)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { seq: number; type: string; payload: Record<string, unknown> });
}

type TimelineAtom = {
  kind: "thinking" | "verification" | "search";
  id: string;
};

function expectedActivitySegments(events: ReturnType<typeof decodeSse>) {
  const atoms = events.flatMap<TimelineAtom>((event) => {
    if (event.type === "thinking.started") {
      return [{
        kind: event.payload.activityKind === "verification" ? "verification" : "thinking",
        id: String(event.payload.thinkingId)
      }];
    }
    if (event.type === "tool.started" && /搜索|search/iu.test(String(event.payload.name || ""))) {
      return [{ kind: "search", id: String(event.payload.toolCallId) }];
    }
    return [];
  });
  return atoms.reduce<TimelineAtom[][]>((segments, atom) => {
    const current = segments.at(-1);
    if (current?.[0]?.kind === atom.kind) current.push(atom);
    else segments.push([atom]);
    return segments;
  }, []);
}

test("真实思考→搜索→再思考链路在 3100 正确展示并可恢复", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto("/workbench");
  await expect(page.getByRole("heading", { name: "今天想做什么？" })).toBeVisible();

  const threadTitle = `3100 真实搜索验收-${Date.now()}`;
  const createResponse = await postWithVisitorRetry(page, "/api/v1/threads", { projectId: null, title: threadTitle });
  expect(createResponse.ok()).toBe(true);
  const thread = await createResponse.json() as { id: string };
  await page.goto(`/workbench/t/${thread.id}`);
  await expect(page.getByRole("heading", { name: threadTitle, exact: true })).toBeVisible();

  const question = "什么是 CC Switch？";
  const runResponsePromise = page.waitForResponse((response) => response.request().method() === "POST"
    && /\/api\/v1\/threads\/[^/]+\/runs$/u.test(new URL(response.url()).pathname));
  await page.getByLabel("任务输入").fill(question);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const runResponse = await runResponsePromise;
  expect(runResponse.ok()).toBe(true);
  const { runId } = await runResponse.json() as { runId: string };

  await expect(page.locator("[data-thinking-id]").first()).toBeVisible({ timeout: 90_000 });
  const searchSummaries = page.locator("[data-search-activity-summary]");
  await expect(searchSummaries.first()).toBeVisible({ timeout: 180_000 });
  await searchSummaries.first().evaluate((element) => {
    const runtime = window as typeof window & { __searchCountHistory?: string[]; __searchCountObserver?: MutationObserver };
    const record = () => {
      const text = element.querySelector("button span")?.textContent?.trim() || "";
      if (text && runtime.__searchCountHistory?.at(-1) !== text) runtime.__searchCountHistory?.push(text);
    };
    runtime.__searchCountHistory = [];
    record();
    runtime.__searchCountObserver = new MutationObserver(record);
    runtime.__searchCountObserver.observe(element, { childList: true, subtree: true, characterData: true });
  });
  await expect(page.getByRole("button", { name: "复制完整回复" })).toBeVisible({ timeout: 300_000 });
  const conversation = page.getByTestId("conversation-viewport");

  const eventResponse = await page.request.get(`/api/v1/runs/${runId}/events?after=0`);
  expect(eventResponse.ok()).toBe(true);
  const rawEvents = await eventResponse.text();
  expect(rawEvents).not.toMatch(forbiddenPublicText);
  const events = decodeSse(rawEvents);
  const types = events.map((event) => event.type);
  expect(types).toContain("thinking.started");
  expect(types).toContain("thinking.completed");
  expect(types).toContain("tool.started");
  expect(types).toContain("tool.completed");
  expect(types).toContain("message.completed");
  expect(types).toContain("run.completed");
  const completedTools = events.filter((event) => event.type === "tool.completed");
  const completedTool = completedTools[0];
  expect(Array.isArray(completedTool?.payload.sources)).toBe(true);
  expect((completedTool?.payload.sources as unknown[]).length).toBeGreaterThan(0);
  const activitySegments = expectedActivitySegments(events);
  const expectedKinds = activitySegments.map((segment) => segment[0].kind);
  expect(expectedKinds.slice(0, 4)).toEqual(["thinking", "search", "thinking", "verification"]);
  const processRows = conversation.locator("[data-thinking-id], [data-search-activity-summary]");
  await expect(processRows).toHaveCount(activitySegments.length);
  const actualKinds = await processRows.evaluateAll((elements) => elements.map((element) =>
    element.hasAttribute("data-search-activity-summary")
      ? "search"
      : element.getAttribute("data-activity-kind") || "thinking"));
  expect(actualKinds).toEqual(expectedKinds);

  const completedByToolCallId = new Map(completedTools.map((event) => [String(event.payload.toolCallId), event]));
  const searchSegments = activitySegments.filter((segment) => segment[0].kind === "search");
  await expect(searchSummaries).toHaveCount(searchSegments.length);
  const searchStats: Array<{ results: number; verified: number; details: number }> = [];
  for (const [index, segment] of searchSegments.entries()) {
    const toolCallIds = segment.map((atom) => atom.id);
    const segmentCompletions = toolCallIds.flatMap((id) => {
      const completed = completedByToolCallId.get(id);
      return completed ? [completed] : [];
    });
    const results = segmentCompletions.reduce((total, event) => total + Number(event.payload.resultCount || 0), 0);
    const verifiedSources = new Set(segmentCompletions.flatMap((event) => (event.payload.sources as Array<{ url?: string; verified?: boolean }> || []))
      .filter((source) => source.verified && source.url)
      .map((source) => source.url));
    const detailSources = new Set(segmentCompletions.flatMap((event) => (event.payload.sources as Array<{ url?: string }> || []))
      .map((source) => source.url)
      .filter((url): url is string => Boolean(url)));
    searchStats.push({ results, verified: verifiedSources.size, details: detailSources.size });
    const summary = searchSummaries.nth(index);
    await expect(summary).toContainText(`找到 ${results} 条结果，读取 ${verifiedSources.size} 个来源`);
    await expect(summary).toHaveAttribute("data-tool-call-count", String(toolCallIds.length));
    await expect(summary).toHaveAttribute("data-tool-call-ids", toolCallIds.join(","));
    await summary.getByRole("button", { name: "展开搜索详情" }).click();
    await expect(summary.locator("[data-search-activity-details] a")).toHaveCount(detailSources.size);
    expect(await summary.locator("table").count()).toBe(0);
    await expect(summary.locator("[data-search-activity-details]")).not.toContainText(/状态|搜索服务|执行耗时|检索查询|检索计划|检索进展|证据评估|核验结论/u);
  }

  const thinkingUpdates = events.filter((event) => event.type === "thinking.paragraph");
  expect(new Set(thinkingUpdates.map((event) => event.payload.thinkingId)).size).toBe(thinkingUpdates.length);
  expect(thinkingUpdates.every((event) => Array.from(String(event.payload.text)).length <= 160)).toBe(true);
  expect(thinkingUpdates.map((event) => String(event.payload.text)).join("\n")).not.toMatch(/\*\*|__|```|^\s*(?:#{1,6}|[-*+]\s)/mu);
  expect(thinkingUpdates.some((event) => event.payload.agent === "planner")).toBe(true);
  expect(thinkingUpdates.some((event) => event.payload.agent === "researcher")).toBe(true);
  expect(thinkingUpdates.some((event) => event.payload.agent === "reflector")).toBe(true);
  expect(thinkingUpdates.some((event) => event.payload.agent === "verifier")).toBe(true);
  expect(thinkingUpdates.some((event) => event.seq > (completedTool?.seq || 0))).toBe(true);
  const thinkingById = new Map(thinkingUpdates.map((event) => [String(event.payload.thinkingId), event]));
  const thinkingSegments = activitySegments.filter((segment) => segment[0].kind !== "search");
  const thinkingBlocks = page.locator("[data-thinking-id]");
  await expect(thinkingBlocks).toHaveCount(thinkingSegments.length);
  for (const [index, segment] of thinkingSegments.entries()) {
    const block = thinkingBlocks.nth(index);
    await expect(block).toHaveAttribute("data-activity-kind", segment[0].kind);
    const toggle = block.getByRole("button");
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    const updates = segment.flatMap((atom) => {
      const update = thinkingById.get(atom.id);
      return update ? [update] : [];
    });
    await expect(block.locator("p")).toHaveCount(updates.length);
    for (const update of updates) await expect(block).toContainText(String(update.payload.text));
  }
  const conversationText = await conversation.innerText();
  expect(conversationText).not.toMatch(/【(?:协调|规划|搜索|反思|撰写|核验) Agent】/u);
  expect(conversationText).not.toMatch(/任务判断：|检索计划：|检索进展：|证据评估：|回答组织：|核验结论：/u);
  expect(conversationText).not.toMatch(/正在(?:读取会话上下文|判断任务是否需要搜索|制定搜索计划|调用搜索并观察结果|评估现有证据|基于证据组织回答|核验回答与证据|收口运行结果)/u);
  expect(conversationText).not.toMatch(forbiddenPublicText);
  await expect(conversation.locator('a[href^="http"]').first()).toBeVisible();

  const countHistory = await page.evaluate(() => (window as typeof window & { __searchCountHistory?: string[] }).__searchCountHistory || []);
  const increments = countHistory.flatMap((text) => {
    const match = text.match(/找到 (\d+) 条结果，读取 (\d+) 个来源/u);
    return match ? [[Number(match[1]), Number(match[2])]] : [];
  });
  expect(increments.at(-1)).toEqual([searchStats[0].results, searchStats[0].verified]);
  for (let index = 1; index < increments.length; index += 1) {
    expect(increments[index][0]).toBeGreaterThanOrEqual(increments[index - 1][0]);
    expect(increments[index][1]).toBeGreaterThanOrEqual(increments[index - 1][1]);
  }
  if (searchSegments[0].length > 1) expect(increments.length).toBeGreaterThan(1);

  const evidenceDirectory = path.resolve(process.cwd(), "..", "..", "docs", "development", "evidence");
  await mkdir(evidenceDirectory, { recursive: true });
  await thinkingBlocks.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidenceDirectory, "2026-07-28-issue-7-desktop.png"), fullPage: true });

  await page.reload();
  const restoredSearchSummaries = page.locator("[data-search-activity-summary]");
  await expect(restoredSearchSummaries).toHaveCount(searchSegments.length);
  for (const [index, stats] of searchStats.entries()) {
    await expect(restoredSearchSummaries.nth(index)).toContainText(`找到 ${stats.results} 条结果，读取 ${stats.verified} 个来源`);
  }
  const restoredRows = page.getByTestId("conversation-viewport").locator("[data-thinking-id], [data-search-activity-summary]");
  await expect(restoredRows).toHaveCount(activitySegments.length);
  expect(await restoredRows.evaluateAll((elements) => elements.map((element) =>
    element.hasAttribute("data-search-activity-summary")
      ? "search"
      : element.getAttribute("data-activity-kind") || "thinking"))).toEqual(expectedKinds);
  await expect(page.getByRole("button", { name: "复制完整回复" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("conversation-viewport")).toBeVisible();
  const mobileSearchSummary = page.locator("[data-search-activity-summary]").first();
  await mobileSearchSummary.getByRole("button", { name: "展开搜索详情" }).click();
  await expect(mobileSearchSummary.locator("[data-search-activity-details] a")).toHaveCount(searchStats[0].details);
  const overflow = await page.locator("body").evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await thinkingBlocks.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidenceDirectory, "2026-07-28-issue-7-mobile.png"), fullPage: true });
  expect(browserErrors).toEqual([]);
});

test("真实搜索运行可停止，终态唯一且刷新后可继续发送", async ({ page }) => {
  await page.goto("/workbench");
  const threadTitle = `3100 真实停止验收-${Date.now()}`;
  const createResponse = await postWithVisitorRetry(page, "/api/v1/threads", { projectId: null, title: threadTitle });
  expect(createResponse.ok()).toBe(true);
  const thread = await createResponse.json() as { id: string };
  await page.goto(`/workbench/t/${thread.id}`);

  const firstRunResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && /\/api\/v1\/threads\/[^/]+\/runs$/u.test(new URL(response.url()).pathname));
  await page.getByLabel("任务输入").fill("请深入搜索并比较 2026 年常用 Agent 框架的最新能力。 ");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const { runId } = await (await firstRunResponse).json() as { runId: string };
  await expect(page.locator("[data-tool-call-id]").first()).toBeVisible({ timeout: 180_000 });

  const stopResponse = await page.request.post(`/api/v1/runs/${runId}/stop`, { data: {} });
  expect(stopResponse.ok()).toBe(true);
  expect(await stopResponse.json()).toMatchObject({ status: "stopped" });

  const firstEventsResponse = await page.request.get(`/api/v1/runs/${runId}/events?after=0`);
  expect(firstEventsResponse.ok()).toBe(true);
  const firstEvents = decodeSse(await firstEventsResponse.text());
  expect(firstEvents.filter((event) => event.type === "run.cancelled")).toHaveLength(1);
  expect(firstEvents.some((event) => event.type === "run.completed")).toBe(false);
  expect(firstEvents.some((event) => event.type === "message.completed" && event.payload.agentId === "search-agent")).toBe(false);

  await page.waitForTimeout(2_000);
  const stableEventsResponse = await page.request.get(`/api/v1/runs/${runId}/events?after=0`);
  const stableEvents = decodeSse(await stableEventsResponse.text());
  expect(stableEvents.map((event) => event.seq)).toEqual(firstEvents.map((event) => event.seq));

  await page.reload();
  const secondRunResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && /\/api\/v1\/threads\/[^/]+\/runs$/u.test(new URL(response.url()).pathname));
  await page.getByLabel("任务输入").fill("继续：什么是 LangGraph？");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const secondRun = await (await secondRunResponse).json() as { runId: string };
  expect(secondRun.runId).not.toBe(runId);
  const secondStop = await page.request.post(`/api/v1/runs/${secondRun.runId}/stop`, { data: {} });
  expect(secondStop.ok()).toBe(true);
  expect(await secondStop.json()).toMatchObject({ status: "stopped" });
});
