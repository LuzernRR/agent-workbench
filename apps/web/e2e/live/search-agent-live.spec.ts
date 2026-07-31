import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIResponse, type Page } from "@playwright/test";

test.skip(process.env.LIVE_SEARCH_E2E !== "1", "真实 Provider 验收需要显式开启");

const forbiddenPublicText = /reasoning_content|authorization|apiKey|systemPrompt|toolArguments/iu;

async function postWithVisitorRetry(page: Page, url: string, data: Record<string, unknown>) {
  let response: APIResponse | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await page.request.post(url, { data });
    const status = response.status();
    const isVisitorBootstrap = status === 401;
    const isCloudflareGatewayError = [502, 503, 504].includes(status)
      && response.headers().server?.toLowerCase().includes("cloudflare");
    if ((!isVisitorBootstrap && !isCloudflareGatewayError) || attempt === 2) return response;

    await response.dispose();
    if (isCloudflareGatewayError) await page.waitForTimeout(500 * (attempt + 1));
  }
  return response!;
}

function decodeSse(text: string) {
  return text.split(/\r?\n/u)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { seq: number; type: string; payload: Record<string, unknown> });
}

function sourceIdentity(value: string) {
  const url = new URL(value);
  url.hash = "";
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.href;
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

test("真实自适应思考与搜索链路在生产入口正确展示并可恢复", async ({ page }) => {
  const browserErrors: string[] = [];
  const recoveredSseProtocolErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location().url;
    if (
      message.text() === "Failed to load resource: net::ERR_HTTP2_PROTOCOL_ERROR"
      && /\/api\/v1\/runs\/[^/]+\/events(?:\?|$)/u.test(location)
    ) {
      // Cloudflare may rotate a long-lived HTTP/2 EventSource connection.
      // EventSource reconnects with Last-Event-ID; the durable-event and
      // refresh assertions below prove that no event was lost.
      recoveredSseProtocolErrors.push(location);
      return;
    }
    browserErrors.push(location ? `${message.text()} @ ${location}` : message.text());
  });

  await page.goto("/workbench");
  await expect(page.getByRole("heading", { name: "今天想做什么？" })).toBeVisible();

  const threadTitle = `生产入口真实搜索验收-${Date.now()}`;
  const createResponse = await postWithVisitorRetry(page, "/api/v1/threads", { projectId: null, title: threadTitle });
  expect(createResponse.ok()).toBe(true);
  const thread = await createResponse.json() as { id: string };
  await page.goto(`/workbench/t/${thread.id}`);
  await expect(page.getByRole("heading", { name: threadTitle, exact: true })).toBeVisible();
  await page.getByTestId("conversation-viewport").evaluate((element) => {
    const runtime = window as typeof window & {
      __thinkingStreamHistory?: Record<string, string[]>;
      __thinkingLabelHistory?: string[];
      __thinkingDisclosureHistory?: Record<string, string[]>;
      __sourceStreamHistory?: Record<string, string[]>;
      __answerLengthHistory?: number[];
      __thinkingStreamObserver?: MutationObserver;
    };
    runtime.__thinkingStreamHistory = {};
    runtime.__thinkingLabelHistory = [];
    runtime.__thinkingDisclosureHistory = {};
    runtime.__sourceStreamHistory = {};
    runtime.__answerLengthHistory = [];
    const record = () => {
      element.querySelectorAll<HTMLElement>("[data-thinking-id]").forEach((block) => {
        const id = block.dataset.thinkingId || "";
        const label = block.querySelector("button span")?.textContent?.trim() || "";
        if (label && runtime.__thinkingLabelHistory?.at(-1) !== label) {
          runtime.__thinkingLabelHistory?.push(label);
        }
        if (id && label) {
          const disclosure = `${label}|${block.querySelector("button")?.getAttribute("aria-expanded") || ""}`;
          const disclosureHistory = runtime.__thinkingDisclosureHistory?.[id] || [];
          if (disclosureHistory.at(-1) !== disclosure) disclosureHistory.push(disclosure);
          if (runtime.__thinkingDisclosureHistory) {
            runtime.__thinkingDisclosureHistory[id] = disclosureHistory;
          }
        }
        if (!id) return;
        const text = [...block.querySelectorAll("p")]
          .map((paragraph) => paragraph.textContent || "")
          .join("\n\n");
        if (!text) return;
        const history = runtime.__thinkingStreamHistory?.[id] || [];
        if (history.at(-1) !== text) history.push(text);
        if (runtime.__thinkingStreamHistory) runtime.__thinkingStreamHistory[id] = history;
      });
      element.querySelectorAll<HTMLAnchorElement>("[data-search-activity-details] a[href]").forEach((link) => {
        const href = link.href;
        const text = link.textContent?.trim() || "";
        if (!href || !text) return;
        let history = runtime.__sourceStreamHistory?.[href] || [];
        const previousText = history.at(-1) || "";
        if (Array.from(text).length < Array.from(previousText).length) {
          history = [];
        }
        if (history.at(-1) !== text) history.push(text);
        if (runtime.__sourceStreamHistory) runtime.__sourceStreamHistory[href] = history;
      });
      const answer = [...element.querySelectorAll<HTMLElement>("[data-assistant-stream-length]")].at(-1);
      const answerLength = Number(answer?.dataset.assistantStreamLength || 0);
      if (
        answerLength > 0
        && runtime.__answerLengthHistory?.at(-1) !== answerLength
      ) {
        runtime.__answerLengthHistory?.push(answerLength);
      }
    };
    runtime.__thinkingStreamObserver = new MutationObserver(record);
    runtime.__thinkingStreamObserver.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-activity-status", "aria-expanded", "data-assistant-stream-length"]
    });
    record();
  });

  const question = "请搜索小红书上关于 LangGraph 的笔记，概括大家如何区分 LangChain、LangGraph 和 LangSmith，并引用已读取来源。";
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
  const completedReply = page.getByRole("button", { name: "复制完整回复" });
  const failedReply = page.getByText("Search Agent 运行失败", { exact: true });
  await expect(completedReply.or(failedReply)).toBeVisible({ timeout: 300_000 });
  await expect(completedReply).toBeVisible();
  const conversation = page.getByTestId("conversation-viewport");

  const eventResponse = await page.request.get(`/api/v1/runs/${runId}/events?after=0`);
  expect(eventResponse.ok()).toBe(true);
  const rawEvents = await eventResponse.text();
  expect(rawEvents).not.toMatch(forbiddenPublicText);
  const events = decodeSse(rawEvents);
  const types = events.map((event) => event.type);
  expect(types).toContain("thinking.started");
  expect(types).toContain("thinking.delta");
  expect(types).toContain("thinking.completed");
  expect(types).toContain("tool.started");
  expect(types).toContain("tool.progress");
  expect(types).toContain("tool.completed");
  expect(types).toContain("tool.source.delta");
  expect(types).toContain("message.delta");
  expect(types).toContain("message.completed");
  expect(types).toContain("run.completed");
  const completedTools = events.filter((event) => event.type === "tool.completed");
  const settledTools = events.filter((event) =>
    event.type === "tool.completed" || event.type === "tool.failed");
  expect(completedTools.every((event) => Array.isArray(event.payload.sources))).toBe(true);
  const completedTool = completedTools.find((event) =>
    (event.payload.sources as unknown[]).length > 0);
  expect(completedTool).toBeDefined();
  const xiaohongshuTools = completedTools.filter((event) => event.payload.channel === "xiaohongshu");
  expect(xiaohongshuTools.length).toBeGreaterThan(0);
  expect(xiaohongshuTools.some((event) => Number(event.payload.resultCount || 0) > 0)).toBe(true);
  const xiaohongshuHasEvidence = xiaohongshuTools.some(
    (event) => Number(event.payload.evidenceCount || 0) > 0
  );
  const xiaohongshuUsedControlledFallback = xiaohongshuTools.some((event) =>
    /xiaohongshu-mcp-fallback\[(?:CAPTCHA_REQUIRED|MCP_[A-Z_]+)\]/u.test(
      String(event.payload.provider || "")
    ));
  expect(xiaohongshuHasEvidence || xiaohongshuUsedControlledFallback).toBe(true);
  const progressByToolCallId = new Map<string, Array<[number, number]>>();
  for (const event of events.filter((candidate) => candidate.type === "tool.progress")) {
    const toolCallId = String(event.payload.toolCallId);
    const values = progressByToolCallId.get(toolCallId) || [];
    values.push([
      Number(event.payload.resultCount || 0),
      Number(event.payload.evidenceCount || 0)
    ]);
    progressByToolCallId.set(toolCallId, values);
  }
  expect(progressByToolCallId.size).toBeGreaterThan(0);
  expect([...progressByToolCallId.values()].some((values) => values.length > 1)).toBe(true);
  for (const values of progressByToolCallId.values()) {
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index][0]).toBeGreaterThanOrEqual(values[index - 1][0]);
      expect(values[index][1]).toBeGreaterThanOrEqual(values[index - 1][1]);
    }
  }
  const activitySegments = expectedActivitySegments(events);
  const expectedKinds = activitySegments.map((segment) => segment[0].kind);
  expect(expectedKinds.slice(0, 3)).toEqual(["thinking", "search", "thinking"]);
  const verificationIndex = expectedKinds.indexOf("verification");
  expect(verificationIndex).toBeGreaterThan(2);
  expect(expectedKinds.slice(2, verificationIndex)).toContain("thinking");
  for (let index = 1; index < expectedKinds.length; index += 1) {
    expect(expectedKinds[index]).not.toBe(expectedKinds[index - 1]);
  }
  const processRows = conversation.locator("[data-thinking-id], [data-search-activity-summary]");
  await expect(processRows).toHaveCount(activitySegments.length);
  const actualKinds = await processRows.evaluateAll((elements) => elements.map((element) =>
    element.hasAttribute("data-search-activity-summary")
      ? "search"
      : element.getAttribute("data-activity-kind") || "thinking"));
  expect(actualKinds).toEqual(expectedKinds);

  const settledByToolCallId = new Map(settledTools.map((event) => [String(event.payload.toolCallId), event]));
  const presentedByToolCallId = new Map<string, Set<string>>();
  const sourceTextByUrl = new Map<string, string>();
  for (const event of events.filter((candidate) => candidate.type === "tool.source.delta")) {
    const toolCallId = String(event.payload.toolCallId || "");
    const url = typeof event.payload.url === "string" ? event.payload.url : "";
    const delta = typeof event.payload.delta === "string" ? event.payload.delta : "";
    const urls = presentedByToolCallId.get(toolCallId) || new Set<string>();
    if (url && delta.trim()) {
      const identity = sourceIdentity(url);
      urls.add(identity);
      sourceTextByUrl.set(identity, `${sourceTextByUrl.get(identity) || ""}${delta}`);
    }
    if (urls.size) presentedByToolCallId.set(toolCallId, urls);
  }
  expect([...presentedByToolCallId.values()].some((urls) => urls.size > 0)).toBe(true);
  const searchSegments = activitySegments.filter((segment) => segment[0].kind === "search");
  await expect(searchSummaries).toHaveCount(searchSegments.length);
  const searchStats: Array<{ results: number; verified: number; details: number }> = [];
  for (const [index, segment] of searchSegments.entries()) {
    const toolCallIds = segment.map((atom) => atom.id);
    const segmentSettlements = toolCallIds.flatMap((id) => {
      const settled = settledByToolCallId.get(id);
      return settled ? [settled] : [];
    });
    expect(segmentSettlements).toHaveLength(toolCallIds.length);
    const results = segmentSettlements.reduce((total, event) => total + Number(event.payload.resultCount || 0), 0);
    const verifiedSources = new Set(segmentSettlements.flatMap((event) => (event.payload.sources as Array<{ url?: string; verified?: boolean }> || []))
      .filter((source) => source.verified && source.url)
      .map((source) => sourceIdentity(source.url!)));
    const detailSources = new Set(toolCallIds.flatMap((id) => [...(presentedByToolCallId.get(id) || [])]));
    // 已读来源只表示正文通过读取；详情还必须由 LangGraph Agent 判定为直接支持
    // 当前问题且符合用户筛选条件。详情绝不能引入未读或无关 URL。
    expect([...detailSources].every((url) => verifiedSources.has(url))).toBe(true);
    searchStats.push({ results, verified: verifiedSources.size, details: detailSources.size });
    const summary = searchSummaries.nth(index);
    await expect(summary).toContainText(`找到 ${results} 条结果，读取 ${verifiedSources.size} 个来源`);
    await expect(summary).toHaveAttribute("data-tool-call-count", String(toolCallIds.length));
    await expect(summary).toHaveAttribute("data-tool-call-ids", toolCallIds.join(","));
    if (detailSources.size) {
      await summary.getByRole("button", { name: "展开搜索详情" }).click();
      const details = summary.locator("[data-search-activity-details]");
      await expect(details.locator("a")).toHaveCount(detailSources.size);
      if (segmentSettlements.some((event) => event.payload.channel === "xiaohongshu")) {
        await expect(details).toContainText("小红书");
      }
      await expect(details).not.toContainText(/(?:状态|搜索服务|执行耗时|检索查询|检索计划|检索进展|证据评估|核验结论)\s*[：:]/u);
      await expect(details).not.toContainText(/未(?:成功)?(?:读取|加载|获取|核验|验证)|仅(?:发现|检索到).{0,12}(?:候选|索引)|(?:仅|只).{0,12}(?:标题|标签|话题|关键词)|未.{0,6}(?:展开|涉及|提及).{0,60}(?:对比|区别|内容|信息|说明|细节|证据)|无.{0,12}(?:有效|实质|相关).{0,8}(?:内容|信息|证据|说明)/u);
    } else {
      await expect(summary.locator("[data-search-activity-details]")).toHaveCount(0);
    }
    expect(await summary.locator("table").count()).toBe(0);
  }

  const thinkingUpdates = events.filter((event) => event.type === "thinking.delta");
  const thinkingIds = new Set(thinkingUpdates.map((event) => String(event.payload.thinkingId)));
  expect(thinkingIds.size).toBeGreaterThan(0);
  expect(thinkingUpdates.every((event) => Array.from(String(event.payload.delta)).length <= 160)).toBe(true);
  expect(thinkingUpdates.map((event) => String(event.payload.delta)).join("\n")).not.toMatch(/\*\*|__|```|^\s*(?:#{1,6}|[-*+]\s)/mu);
  expect(thinkingUpdates.some((event) => event.payload.agent === "planner")).toBe(true);
  expect(thinkingUpdates.some((event) => event.payload.agent === "researcher")).toBe(true);
  expect(thinkingUpdates.some((event) => event.payload.agent === "reflector")).toBe(true);
  expect(thinkingUpdates.some((event) => event.payload.agent === "verifier")).toBe(true);
  expect(thinkingUpdates.some((event) => event.seq > (completedTool?.seq || 0))).toBe(true);
  const thinkingTextById = new Map<string, string>();
  for (const event of thinkingUpdates) {
    const id = String(event.payload.thinkingId);
    thinkingTextById.set(id, `${thinkingTextById.get(id) || ""}${String(event.payload.delta)}`);
  }
  const thinkingSegments = activitySegments.filter((segment) => segment[0].kind !== "search");
  const streamObservation = await page.evaluate(() => {
    const runtime = window as typeof window & {
      __thinkingStreamHistory?: Record<string, string[]>;
      __thinkingLabelHistory?: string[];
      __thinkingDisclosureHistory?: Record<string, string[]>;
      __sourceStreamHistory?: Record<string, string[]>;
      __answerLengthHistory?: number[];
    };
    return {
      histories: runtime.__thinkingStreamHistory || {},
      labels: runtime.__thinkingLabelHistory || [],
      disclosures: runtime.__thinkingDisclosureHistory || {},
      sourceHistories: runtime.__sourceStreamHistory || {},
      answerLengths: runtime.__answerLengthHistory || []
    };
  });
  expect(streamObservation.labels).toContain("思考中");
  expect(streamObservation.labels).toContain("核验中");
  for (const segment of thinkingSegments) {
    const text = segment.map((atom) => thinkingTextById.get(atom.id) || "").filter(Boolean).join("\n\n");
    const history = streamObservation.histories[segment[0].id] || [];
    expect(history.length).toBeGreaterThan(1);
    expect(history.at(-1)).toBe(text);
    for (let index = 1; index < history.length; index += 1) {
      expect(Array.from(history[index]).length).toBeGreaterThan(Array.from(history[index - 1]).length);
    }
    const disclosure = streamObservation.disclosures[segment[0].id] || [];
    const firstCollapsed = disclosure.findIndex((frame) => frame.endsWith("|false"));
    if (firstCollapsed >= 0) {
      expect(disclosure.slice(firstCollapsed + 1).some((frame) => frame.endsWith("|true"))).toBe(false);
    }
  }
  for (const [url, text] of sourceTextByUrl) {
    const matchingHistory = Object.entries(streamObservation.sourceHistories)
      .find(([href]) => sourceIdentity(href) === url)?.[1];
    const history = matchingHistory || [];
    expect(history.length).toBeGreaterThan(1);
    expect(history.some((frame) => frame.includes(text))).toBe(true);
    for (let index = 1; index < history.length; index += 1) {
      expect(Array.from(history[index]).length).toBeGreaterThanOrEqual(Array.from(history[index - 1]).length);
    }
  }
  const answerDelta = events
    .filter((event) => event.type === "message.delta")
    .map((event) => String(event.payload.delta || ""))
    .join("");
  const completedAnswer = [...events]
    .reverse()
    .find((event) => event.type === "message.completed" && typeof event.payload.text === "string");
  expect(answerDelta).toBe(String(completedAnswer?.payload.text || ""));
  expect(streamObservation.answerLengths.length).toBeGreaterThan(1);
  expect(streamObservation.answerLengths.at(-1)).toBe(Array.from(answerDelta).length);
  for (let index = 1; index < streamObservation.answerLengths.length; index += 1) {
    expect(streamObservation.answerLengths[index]).toBeGreaterThan(streamObservation.answerLengths[index - 1]);
  }
  const thinkingBlocks = page.locator("[data-thinking-id]");
  await expect(thinkingBlocks).toHaveCount(thinkingSegments.length);
  for (const [index, segment] of thinkingSegments.entries()) {
    const block = thinkingBlocks.nth(index);
    await expect(block).toHaveAttribute("data-activity-kind", segment[0].kind);
    await expect(block).toHaveAttribute("data-activity-status", "completed");
    const toggle = block.getByRole("button", {
      name: segment[0].kind === "verification" ? /^核验结束/u : /^思考结束/u
    });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(block.locator("p")).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const updates = segment.flatMap((atom) => {
      const text = thinkingTextById.get(atom.id);
      return text ? [text] : [];
    });
    await expect(block.locator("p")).toHaveCount(updates.length);
    for (const update of updates) await expect(block).toContainText(update);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  }
  expect((await thinkingBlocks.allInnerTexts()).join("\n")).not.toMatch(
    /渠道降级|未(?:成功)?(?:读取|获取|加载).{0,12}(?:正文|内容|详情)|(?:正文|详情).{0,12}未(?:读取|获取|加载)|仅(?:发现|检索到).{0,12}(?:候选|索引)|其余来源.{0,16}未读取/u
  );
  const conversationText = await conversation.innerText();
  expect(conversationText).not.toMatch(/【(?:协调|规划|搜索|反思|撰写|核验) Agent】/u);
  expect(conversationText).not.toMatch(/任务判断：|检索计划：|检索进展：|证据评估：|回答组织：|核验结论：/u);
  expect(conversationText).toMatch(/思考结束/u);
  expect(conversationText).toMatch(/核验结束/u);
  expect(conversationText).not.toMatch(/思考结果|核验结果/u);
  expect(conversationText).not.toMatch(/但帖子详情\/正文内容未读取|仅发现公开候选|尚未核验/u);
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
  await page.screenshot({ path: path.join(evidenceDirectory, "2026-07-29-issue-9-desktop.png"), fullPage: true });

  await page.reload();
  const restoredSearchSummaries = page.locator("[data-search-activity-summary]");
  await expect(restoredSearchSummaries).toHaveCount(searchSegments.length);
  for (const [index, stats] of searchStats.entries()) {
    const restoredSummary = restoredSearchSummaries.nth(index);
    await expect(restoredSummary).toContainText(`找到 ${stats.results} 条结果，读取 ${stats.verified} 个来源`);
    if (stats.verified) {
      await restoredSummary.getByRole("button", { name: "展开搜索详情" }).click();
      await expect(restoredSummary.locator("[data-search-activity-details] a")).toHaveCount(stats.verified);
      await restoredSummary.getByRole("button", { name: "收起搜索详情" }).click();
    }
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
  const mobileSearchIndex = searchStats.findIndex((stats) => stats.details > 0);
  expect(mobileSearchIndex).toBeGreaterThanOrEqual(0);
  const mobileSearchSummary = page.locator("[data-search-activity-summary]").nth(mobileSearchIndex);
  await mobileSearchSummary.getByRole("button", { name: "展开搜索详情" }).click();
  await expect(mobileSearchSummary.locator("[data-search-activity-details] a")).toHaveCount(searchStats[mobileSearchIndex].details);
  const overflow = await page.locator("body").evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await thinkingBlocks.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidenceDirectory, "2026-07-29-issue-9-mobile.png"), fullPage: true });
  expect(recoveredSseProtocolErrors.length).toBeLessThanOrEqual(4);
  expect(browserErrors).toEqual([]);
});

test("真实搜索运行可停止，终态唯一且刷新后可继续发送", async ({ page }) => {
  await page.goto("/workbench");
  const threadTitle = `生产入口真实停止验收-${Date.now()}`;
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
