import { expect, test, type Locator, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const runtimeErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(`页面异常：${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`控制台异常：${message.text()}`);
  });
});

test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page) || [], "浏览器不得出现未处理错误").toEqual([]);
});

async function openWorkbench(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天想做什么？" })).toBeVisible();
  await expect(page.getByTestId("composer")).toBeVisible();
}

async function createThread(page: Page, title: string) {
  const response = await page.request.post("/api/v1/threads", {
    data: { projectId: null, title }
  });
  expect(response.ok()).toBe(true);
  return await response.json() as { id: string; title: string };
}

async function createProject(page: Page, name: string) {
  const response = await page.request.post("/api/v1/projects", { data: { name } });
  expect(response.ok()).toBe(true);
  return await response.json() as { id: string; name: string };
}

async function createProjectThread(page: Page, projectId: string, title: string) {
  const response = await page.request.post(`/api/v1/projects/${projectId}/threads`, { data: { title } });
  expect(response.ok()).toBe(true);
  return await response.json() as { id: string; projectId: string; title: string };
}

async function runThreadAndWait(page: Page, threadId: string, message: string) {
  const response = await page.request.post(`/api/v1/threads/${threadId}/runs`, {
    data: { message, modelId: "deepseek-v4-flash", reasoningEffort: "medium", attachmentIds: [], replaceMessageId: null }
  });
  expect(response.ok()).toBe(true);
  const run = await response.json() as { runId: string };
  const events = await page.request.get(`/api/v1/runs/${run.runId}/events?after=0`);
  expect(events.ok()).toBe(true);
  expect(await events.text()).toContain("event: run.completed");
}

async function directDrag(page: Page, source: Locator, target: Locator, beforeDrop?: () => Promise<void>) {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 });
  await beforeDrop?.();
  await page.mouse.up();
}

test("首页、真实模型与高密度工作台布局", async ({ page }, testInfo) => {
  await openWorkbench(page);

  await expect(page.getByLabel("项目与会话")).toBeVisible();
  const navigation = page.getByLabel("项目与会话");
  await expect(navigation.getByRole("heading", { name: "项目", exact: true })).toBeVisible();
  await expect(navigation.getByRole("heading", { name: "会话", exact: true })).toBeVisible();
  const projectTree = navigation.getByRole("tree", { name: "项目会话树" });
  await expect(projectTree).toBeVisible();
  await expect(projectTree.locator('[role="treeitem"][aria-expanded="true"]').first()).toBeVisible();
  const firstProjectToggle = projectTree.getByRole("button", { name: /^收起项目 /u }).first();
  await firstProjectToggle.click();
  await expect(projectTree.getByRole("button", { name: /^展开项目 /u }).first()).toBeVisible();

  const threadRows = navigation.getByTestId("thread-row");
  await expect(threadRows.first()).toBeVisible();
  const rowMetrics = await threadRows.evaluateAll((rows) => rows.map((row) => {
    const title = row.querySelector<HTMLElement>('[data-testid="thread-title"]');
    const style = title ? window.getComputedStyle(title) : null;
    return { height: row.getBoundingClientRect().height, whiteSpace: style?.whiteSpace, textOverflow: style?.textOverflow };
  }));
  expect(rowMetrics.every((row) => row.height <= 36 && row.whiteSpace === "nowrap" && row.textOverflow === "clip")).toBe(true);
  expect(await navigation.innerText()).not.toContain("独立会话");

  await page.getByRole("button", { name: "选择模型" }).click();
  await expect(page.getByRole("button", { name: "选择模型" })).toHaveText("模型");
  await expect(page.getByText("DeepSeek V4 Flash", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "DeepSeek V4 Pro", exact: true })).toContainText("deepseek-v4-pro");
  await page.getByRole("button", { name: "DeepSeek V4 Flash", exact: true }).click();
  await expect(page.getByRole("button", { name: "选择模型" })).toHaveAttribute("title", "DeepSeek V4 Flash");

  await page.getByRole("button", { name: "折叠左栏" }).click();
  await expect(page.getByRole("button", { name: "展开左栏" })).toBeVisible();
  await page.getByRole("button", { name: "展开左栏" }).click();
  await expect(page.getByLabel("项目与会话")).toBeVisible();

  const visibleText = await page.locator("body").innerText();
  expect(visibleText).not.toMatch(/万能搜索|出海选品|企业知识库/u);
  expect(visibleText).not.toMatch(/\.\.\.|…/u);
  await testInfo.attach("阶段 1 工作台首页", { body: await page.screenshot(), contentType: "image/png" });
});

test("空导航无说明占位且交互控件不出现矩形焦点框", async ({ page }) => {
  await page.route("**/api/v1/projects", (route) => route.request().method() === "GET"
    ? route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: "[]" })
    : route.continue());
  await page.route("**/api/v1/threads", (route) => route.request().method() === "GET"
    ? route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: "[]" })
    : route.continue());
  await openWorkbench(page);
  await expect(page.getByRole("status", { name: "正在加载列表" })).toHaveCount(0);
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/还没有项目|创建第一个项目|还没有会话|开始第一个任务|当前范围还没有会话/u);

  const controls = [
    page.getByLabel("任务输入"),
    page.getByRole("button", { name: "上传图片或文档" }),
    page.getByRole("button", { name: "选择模型" })
  ];
  for (const control of controls) {
    await control.click();
    const focusStyle = await control.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    expect(focusStyle.outlineStyle).toBe("none");
    expect(focusStyle.outlineWidth).toBe("0px");
    await control.blur();
  }
  await page.keyboard.press("Escape");
});

test("流式任务、工具、审批、计划、成果、文件、代码与日志", async ({ page }) => {
  await openWorkbench(page);

  await page.getByLabel("任务输入").fill("请运行代码实现一个任务面板页面，并整理方案文档");
  await page.getByRole("button", { name: "发送", exact: true }).click();

  const thinkingBlock = page.locator("[data-thinking-id]").first();
  await expect(thinkingBlock).toBeVisible();
  await expect(thinkingBlock).toHaveAttribute("data-activity-status", "completed");
  const thinkingToggle = thinkingBlock.getByRole("button", { name: "思考结束" });
  await expect(thinkingToggle).toHaveAttribute("aria-expanded", "false");
  await thinkingToggle.click();
  await expect(thinkingBlock).toContainText("这次请求需要围绕");
  await expect(thinkingBlock).toContainText("我会先读取当前可用上下文");
  await expect(thinkingBlock).toContainText("请运行代码实现一个任务面板页面，并整理方案文档");
  await expect(thinkingToggle).toHaveAttribute("aria-expanded", "true");
  await expect(thinkingBlock).not.toContainText(/思考中|思考结果/u);
  expect(await thinkingBlock.innerText()).not.toMatch(/问题判断|能力限制|建议方案|处理计划|回答重点|^\s*(?:[-*#]|\d+[.、])\s+/mu);
  expect(await page.getByTestId("conversation-viewport").innerText()).not.toContain("reasoning_content");

  await expect(page.getByRole("button", { name: "展开工具调用：上下文读取" })).toBeVisible();
  await page.getByRole("button", { name: "展开工具调用：上下文读取" }).click();
  await expect(page.getByText("执行耗时", { exact: true })).toBeVisible();
  await expect(page.getByText(/\d+(?:\.\d+)? 秒/u).first()).toBeVisible();

  await expect(page.getByText("允许本次执行？", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "允许一次", exact: true }).click();
  await expect(page.getByText("已批准工具访问", { exact: true })).toBeVisible();

  await expect(page.getByText(/我已整理「请运行代码实现一个任务面板页面，并整理方案文档」的实现草案/u)).toBeVisible();
  const workspace = page.getByRole("complementary", { name: "工作区", exact: true });
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole("tab", { name: "计划" })).toBeVisible();
  await expect(workspace.getByRole("tab", { name: "成果" })).toBeVisible();
  await expect(workspace.getByRole("tab", { name: "文件" })).toBeVisible();
  await expect(workspace.getByRole("tab", { name: "代码" })).toBeVisible();
  await expect(workspace.getByRole("tab", { name: "日志" })).toBeVisible();

  await workspace.getByRole("tab", { name: "代码" }).click();
  await expect(workspace.getByText("TaskPanel.tsx", { exact: true })).toBeVisible();

  await workspace.getByRole("tab", { name: "文件" }).click();
  await expect(workspace.getByTitle("TaskPanel.tsx")).toBeVisible();

  await workspace.getByRole("tab", { name: "日志" }).click();
  await expect(workspace.getByText("助手", { exact: true }).first()).toBeVisible();
  const logText = await workspace.innerText();
  expect(logText).not.toMatch(/\bagent\b|context_read|\d+ms\b/iu);

  await workspace.getByRole("tab", { name: "成果" }).click();
  const artifactDownload = page.waitForEvent("download");
  await workspace.getByRole("link", { name: "下载成果" }).click();
  const downloadedArtifact = await artifactDownload;
  expect(downloadedArtifact.suggestedFilename()).toBe("任务整理.md");

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "复制完整回复" }).click();
  await page.getByRole("button", { name: "全屏查看" }).click();
  await expect(page.getByRole("button", { name: "退出全屏" })).toBeVisible();
  await page.getByRole("button", { name: "退出全屏" }).click();
  await page.getByRole("button", { name: "折叠右栏" }).click();
  await expect(page.getByRole("button", { name: "展开工作区" })).toBeVisible();
  await page.getByRole("button", { name: "展开工作区" }).click();
  await expect(workspace).toBeVisible();

  await page.reload();
  const restoredThinking = page.locator("[data-thinking-id]").first();
  await expect(restoredThinking).toBeVisible();
  await expect(restoredThinking).toHaveAttribute("data-activity-status", "completed");
  await restoredThinking.getByRole("button", { name: "思考结束" }).click();
  await expect(restoredThinking).toContainText(/这次请求需要围绕/u);
});

test("运行可停止并恢复发送状态", async ({ page }) => {
  await openWorkbench(page);
  const threadTitle = `停止交互测试-${Date.now()}`;
  await createThread(page, threadTitle);
  await page.reload();
  await page.getByText(threadTitle, { exact: true }).click();
  await expect(page.getByRole("heading", { name: threadTitle, exact: true })).toBeVisible();
  await page.route("**/api/v1/threads/*/runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ response });
  });
  await page.getByLabel("任务输入").fill("请整理一份详细的计划文档");
  const startResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/v1\/threads\/[^/]+\/runs$/u.test(new URL(response.url()).pathname));
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "停止执行" })).toHaveCount(0);
  const startResponse = await startResponsePromise;
  expect(startResponse.ok()).toBe(true);
  const { runId } = await startResponse.json() as { runId: string };
  const stopButton = page.getByRole("button", { name: "停止执行" });
  await expect(stopButton).toBeVisible();
  const stopResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/runs/${runId}/stop`);
  await stopButton.click();
  const stopResponse = await stopResponsePromise;
  expect(stopResponse.status()).toBe(200);
  expect(await stopResponse.json()).toEqual({ status: "stopped" });
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const repeatedStop = await page.request.post(`/api/v1/runs/${runId}/stop`);
    expect(repeatedStop.status()).toBe(200);
    expect(await repeatedStop.json()).toEqual({ status: "stopped" });
  }
  const eventResponse = await page.request.get(`/api/v1/runs/${runId}/events?after=0`);
  expect(eventResponse.ok()).toBe(true);
  const events = (await eventResponse.text()).split(/\r?\n/u)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { type: string });
  const cancelledIndexes = events.map((event, index) => event.type === "run.cancelled" ? index : -1).filter((index) => index >= 0);
  expect(cancelledIndexes).toHaveLength(1);
  expect(events.slice(cancelledIndexes[0] + 1).some((event) => ["text.delta", "message.completed", "run.completed"].includes(event.type))).toBe(false);
  await page.waitForTimeout(300);
  const stableEventResponse = await page.request.get(`/api/v1/runs/${runId}/events?after=0`);
  const stableEvents = (await stableEventResponse.text()).split(/\r?\n/u).filter((line) => line.startsWith("data: "));
  expect(stableEvents).toHaveLength(events.length);

  await page.getByRole("button", { name: "编辑最新消息" }).click();
  await page.getByLabel("编辑当前消息").fill("请整理一个更精简的计划");
  await page.getByRole("button", { name: "发送修改" }).click();
  await expect(page.getByRole("button", { name: "停止执行" })).toBeVisible();
  await page.getByRole("button", { name: "停止执行" }).click();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
});

test("流式输出尊重用户向上滚动并由用户决定恢复跟随", async ({ page }) => {
  await openWorkbench(page);
  const thread = await createThread(page, `滚动行为验收-${Date.now()}`);
  for (let index = 1; index <= 4; index += 1) {
    await runThreadAndWait(page, thread.id, `请整理第 ${index} 轮详细实现方案与检查步骤`);
  }
  await page.goto(`/workbench/t/${thread.id}`);
  const viewport = page.getByTestId("conversation-viewport");
  await expect(viewport).toBeVisible();
  expect(await viewport.evaluate((element) => element.scrollHeight > element.clientHeight + 100)).toBe(true);

  await page.getByLabel("任务输入").fill("继续生成一轮详细实现方案与检查步骤");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止执行" })).toBeVisible();
  await viewport.hover();
  await viewport.evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
  await expect(page.getByRole("button", { name: "滚动到底部" })).toBeVisible();
  await page.waitForTimeout(700);
  expect(await viewport.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(2);

  await page.getByRole("button", { name: "滚动到底部" }).click();
  await expect.poll(() => viewport.evaluate((element) => Math.abs(element.scrollHeight - element.scrollTop - element.clientHeight))).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制完整回复" })).toHaveCount(5);
});

test("后台页面冻结动画帧时接收耐久事件，恢复后继续逐字输出", async ({ page }) => {
  await openWorkbench(page);
  const thread = await createThread(page, `后台输出验收-${Date.now()}`);
  await page.goto(`/workbench/t/${thread.id}`);
  await expect(page.getByTestId("composer")).toBeVisible();
  await page.evaluate(() => {
    const host = window as typeof window & {
      __nativeRequestAnimationFrame?: typeof window.requestAnimationFrame;
      __nativeCancelAnimationFrame?: typeof window.cancelAnimationFrame;
      __pendingAnimationFrames?: FrameRequestCallback[];
    };
    host.__nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    host.__nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
    host.__pendingAnimationFrames = [];
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      host.__pendingAnimationFrames?.push(callback);
      return host.__pendingAnimationFrames?.length || 1;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((handle: number) => {
      if (host.__pendingAnimationFrames) host.__pendingAnimationFrames[handle - 1] = () => undefined;
    }) as typeof window.cancelAnimationFrame;
    document.dispatchEvent(new Event("visibilitychange"));
  });

  const runResponsePromise = page.waitForResponse((response) => response.request().method() === "POST"
    && /\/api\/v1\/threads\/[^/]+\/runs$/u.test(new URL(response.url()).pathname));
  await page.getByLabel("任务输入").fill("验证后台页面持续输出");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const { runId } = await (await runResponsePromise).json() as { runId: string };
  await expect(page.getByRole("button", { name: "停止执行" })).toBeVisible();
  await expect.poll(async () => {
    const response = await page.request.get(`/api/v1/runs/${runId}/events?after=0`);
    return response.ok() && (await response.text()).includes("event: run.completed");
  }).toBe(true);
  await expect(page.getByRole("button", { name: "停止执行" })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制完整回复" })).toHaveCount(0);

  await page.evaluate(() => {
    const host = window as typeof window & {
      __nativeRequestAnimationFrame?: typeof window.requestAnimationFrame;
      __nativeCancelAnimationFrame?: typeof window.cancelAnimationFrame;
      __pendingAnimationFrames?: FrameRequestCallback[];
    };
    const pending = [...(host.__pendingAnimationFrames || [])];
    if (host.__nativeRequestAnimationFrame) window.requestAnimationFrame = host.__nativeRequestAnimationFrame;
    if (host.__nativeCancelAnimationFrame) window.cancelAnimationFrame = host.__nativeCancelAnimationFrame;
    Reflect.deleteProperty(document, "visibilityState");
    document.dispatchEvent(new Event("visibilitychange"));
    pending.forEach((callback) => callback(performance.now()));
  });
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制完整回复" })).toHaveCount(1);
});

test("模型选择把真实模型 ID 发送到运行接口", async ({ page }) => {
  await openWorkbench(page);
  await page.getByRole("button", { name: "选择模型" }).click();
  await page.getByRole("button", { name: "DeepSeek V4 Pro", exact: true }).click();
  await expect(page.getByRole("button", { name: "选择模型" })).toHaveAttribute("title", "DeepSeek V4 Pro");
  const runRequest = page.waitForRequest((request) => request.method() === "POST" && /\/api\/v1\/threads\/[^/]+\/runs$/u.test(new URL(request.url()).pathname));
  await page.getByLabel("任务输入").fill("验证真实模型选择");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const payload = (await runRequest).postDataJSON() as { modelId?: string };
  expect(payload.modelId).toBe("deepseek-v4-pro");
  await expect(page.getByRole("button", { name: "复制完整回复" })).toBeVisible();
});

test("编辑消息立即移除旧分支并只持久化新回复", async ({ page }) => {
  await openWorkbench(page);
  const suffix = Date.now();
  const thread = await createThread(page, `编辑分支-${suffix}`);
  await page.goto(`/workbench/t/${thread.id}`);
  const firstQuestion = `第一版问题-${suffix}`;
  const secondQuestion = `第二版问题-${suffix}`;
  const firstReply = `我已完成「${firstQuestion}」的第一轮整理。`;
  const secondReply = `我已完成「${secondQuestion}」的第一轮整理。`;

  await page.getByLabel("任务输入").fill(firstQuestion);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText(firstReply, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑最新消息" }).click();
  const editor = page.getByLabel("编辑当前消息");
  await expect(editor).toBeVisible();
  const editorStyle = await editor.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return { borderWidth: style.borderWidth, outlineStyle: style.outlineStyle, boxShadow: style.boxShadow };
  });
  expect(editorStyle).toEqual({ borderWidth: "0px", outlineStyle: "none", boxShadow: "none" });
  await editor.fill(secondQuestion);
  await page.getByRole("button", { name: "发送修改" }).click();
  const messages = page.locator("[data-message-id]");
  await expect(messages.getByText(firstReply, { exact: true })).toHaveCount(0);
  await expect(messages.getByText(firstQuestion, { exact: true })).toHaveCount(0);
  await expect(messages.getByText(secondReply, { exact: true })).toBeVisible();
  await expect(messages.getByText(secondQuestion, { exact: true })).toHaveCount(1);

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/workbench/t/${thread.id}$`, "u"));
  await expect(messages.getByText(firstReply, { exact: true })).toHaveCount(0);
  await expect(messages.getByText(firstQuestion, { exact: true })).toHaveCount(0);
  await expect(messages.getByText(secondReply, { exact: true })).toHaveCount(1);
  await expect(messages.getByText(secondQuestion, { exact: true })).toHaveCount(1);
});

test("会话切换使用稳定骨架且不显示旧内容", async ({ page }) => {
  await openWorkbench(page);
  const threadTitle = `切换稳定性测试-${Date.now()}`;
  const createdThread = await createThread(page, threadTitle);
  await page.reload();
  await expect(page.getByRole("heading", { name: "今天想做什么？" })).toBeVisible();

  await page.route(`**/api/v1/threads/${createdThread.id}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });

  await page.getByRole("button", { name: "展开工作区" }).click();
  const workspace = page.getByRole("complementary", { name: "工作区", exact: true });
  await expect(workspace.getByRole("button", { name: "折叠右栏" })).toBeVisible();
  await page.getByText(threadTitle, { exact: true }).click();
  await expect(page.getByRole("status", { name: "正在加载会话" }).last()).toBeVisible();
  await workspace.getByRole("button", { name: "折叠右栏" }).click();
  await expect(page.getByRole("button", { name: "展开工作区" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "今天想做什么？" })).toHaveCount(0);
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: threadTitle })).toBeVisible();
  await expect(page.getByRole("status", { name: "正在加载会话" })).toHaveCount(0);
  await expect(page.getByTestId("composer")).toBeVisible();
});

test("项目、项目内会话和无项目会话遵循唯一归属真值", async ({ page }) => {
  await openWorkbench(page);
  const suffix = Date.now();
  const projectName = `归属项目-${suffix}`;
  const otherProjectName = `其他项目-${suffix}`;
  const projectThreadTitle = `项目内会话-${suffix}`;
  const otherThreadTitle = `其他会话-${suffix}`;
  const standaloneTitle = `无项目会话-${suffix}`;
  const project = await createProject(page, projectName);
  const otherProject = await createProject(page, otherProjectName);
  const projectThread = await createProjectThread(page, project.id, projectThreadTitle);
  await createProjectThread(page, otherProject.id, otherThreadTitle);
  const standalone = await createThread(page, standaloneTitle);
  await page.reload();

  const navigation = page.getByLabel("项目与会话");
  await navigation.getByTitle(projectName, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workbench/p/${project.id}$`, "u"));
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `打开项目 ${projectName}` })).toHaveText(projectName);
  await expect(page.getByRole("button", { name: "切换会话" })).toHaveCount(0);

  await navigation.getByRole("button", { name: `${projectThreadTitle} ${projectName}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workbench/t/${projectThread.id}$`, "u"));
  await expect(page.getByRole("heading", { name: projectThreadTitle, exact: true })).toBeVisible();
  const projectButton = page.getByRole("button", { name: `打开项目 ${projectName}` });
  const switcherButton = page.getByRole("button", { name: "切换会话" });
  await expect(projectButton).toHaveText(projectName);
  await expect(switcherButton).toHaveText(projectThreadTitle);
  await expect(switcherButton).toHaveAttribute("title", projectThreadTitle);
  await switcherButton.click();
  const projectMenu = page.locator('[data-radix-popper-content-wrapper]:visible').last();
  await expect(projectMenu.getByTitle(projectThreadTitle, { exact: true })).toBeVisible();
  await expect(projectMenu.getByTitle(otherThreadTitle, { exact: true })).toHaveCount(0);
  await expect(projectMenu.getByTitle(standaloneTitle, { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await projectButton.click();
  await expect(page).toHaveURL(new RegExp(`/workbench/p/${project.id}$`, "u"));
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();

  await navigation.getByRole("button", { name: standaloneTitle, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workbench/t/${standalone.id}$`, "u"));
  await expect(page.getByRole("heading", { name: standaloneTitle, exact: true })).toBeVisible();
  await expect(switcherButton).toHaveText(standaloneTitle);
  await expect(switcherButton).toHaveAttribute("title", standaloneTitle);
  await switcherButton.click();
  const standaloneMenu = page.locator('[data-radix-popper-content-wrapper]:visible').last();
  await expect(standaloneMenu.getByTitle(standaloneTitle, { exact: true })).toBeVisible();
  await expect(standaloneMenu.getByTitle(projectThreadTitle, { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/workbench/t/${standalone.id}$`, "u"));
  await expect(page.getByRole("heading", { name: standaloneTitle, exact: true })).toBeVisible();
  await expect(switcherButton).toHaveText(standaloneTitle);
});

test("会话 URL 切换不回放旧会话、首页或错误项目", async ({ page }) => {
  await openWorkbench(page);
  const suffix = Date.now();
  const project = await createProject(page, `稳定项目-${suffix}`);
  const source = await createProjectThread(page, project.id, `来源会话-${suffix}`);
  const target = await createThread(page, `目标会话-${suffix}`);
  const targetMessage = `目标会话已有内容-${suffix}`;
  const targetRunResponse = await page.request.post(`/api/v1/threads/${target.id}/runs`, {
    data: { message: targetMessage, modelId: "deepseek-v4-flash", reasoningEffort: "medium", attachmentIds: [], replaceMessageId: null }
  });
  expect(targetRunResponse.ok()).toBe(true);
  const targetRun = await targetRunResponse.json() as { runId: string };
  expect((await page.request.post(`/api/v1/runs/${targetRun.runId}/stop`)).ok()).toBe(true);
  await page.goto(`/workbench/t/${source.id}`);
  await expect(page.getByRole("heading", { name: source.title, exact: true })).toBeVisible();
  const oldMessage = `旧会话专属内容-${suffix}`;
  await page.getByLabel("任务输入").fill(oldMessage);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator("[data-message-id]").getByText(oldMessage, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制完整回复" })).toBeVisible();

  await page.route(`**/api/v1/threads/${target.id}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 450));
    await route.continue();
  });
  await page.evaluate(() => {
    const samples: Array<{ path: string; body: string; heading: string }> = [];
    const capture = () => samples.push({
      path: window.location.pathname,
      body: document.body.innerText,
      heading: document.querySelector("main h1")?.getAttribute("aria-label") || ""
    });
    const observer = new MutationObserver(capture);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-label"] });
    capture();
    Object.assign(window, { __workbenchFlashSamples: samples, __workbenchFlashObserver: observer });
  });

  await page.getByLabel("项目与会话").getByRole("button", { name: targetMessage, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workbench/t/${target.id}$`, "u"));
  await expect(page.getByRole("heading", { name: targetMessage, exact: true })).toBeVisible();
  const targetSamples = await page.evaluate((targetPath) => {
    const host = window as typeof window & { __workbenchFlashSamples?: Array<{ path: string; body: string; heading: string }>; __workbenchFlashObserver?: MutationObserver };
    host.__workbenchFlashObserver?.disconnect();
    return (host.__workbenchFlashSamples || []).filter((sample) => sample.path === targetPath);
  }, `/workbench/t/${target.id}`);
  expect(targetSamples.length).toBeGreaterThan(0);
  expect(targetSamples.every((sample) => !sample.body.includes(oldMessage))).toBe(true);
  expect(targetSamples.every((sample) => !sample.body.includes("今天想做什么？"))).toBe(true);
  expect(targetSamples.every((sample) => !sample.heading.includes(project.name))).toBe(true);
});

test("刷新非空会话的全过程不出现临时文字或乱码", async ({ page }) => {
  await openWorkbench(page);
  const suffix = Date.now();
  const thread = await createThread(page, `刷新验证-${suffix}`);
  const message = `刷新后保持此内容-${suffix}`;
  const runResponse = await page.request.post(`/api/v1/threads/${thread.id}/runs`, {
    data: { message, modelId: "deepseek-v4-flash", reasoningEffort: "medium", attachmentIds: [], replaceMessageId: null }
  });
  const run = await runResponse.json() as { runId: string };
  expect((await page.request.post(`/api/v1/runs/${run.runId}/stop`)).ok()).toBe(true);

  await page.addInitScript(() => {
    const samples: Array<{ body: string; heading: string }> = [];
    Object.assign(window, { __reloadTextSamples: samples });
    const capture = () => {
      if (!document.body || samples.length >= 600) return;
      samples.push({
        body: document.body.innerText,
        heading: document.querySelector("main h1")?.textContent?.trim() || ""
      });
    };
    const observer = new MutationObserver(capture);
    observer.observe(document, { childList: true, subtree: true, characterData: true });
    window.addEventListener("load", capture, { once: true });
  });
  await page.goto(`/workbench/t/${thread.id}`);
  await expect(page.locator("[data-message-id]").getByText(message, { exact: true })).toBeVisible();
  const samples = await page.evaluate(() => (window as typeof window & { __reloadTextSamples?: Array<{ body: string; heading: string }> }).__reloadTextSamples || []);
  expect(samples.length).toBeGreaterThan(0);
  expect(samples.every((sample) => !sample.body.includes("今天想做什么？"))).toBe(true);
  expect(samples.every((sample) => !/还没有项目|创建第一个项目|还没有会话|开始第一个任务/u.test(sample.body))).toBe(true);
  expect(samples.every((sample) => !/�|Ã|Â|å|ä|æ|ç|è|é/u.test(sample.body))).toBe(true);
  expect(samples.every((sample) => !sample.heading || sample.heading === message)).toBe(true);
});

test("直接拖拽具有动画并持久化项目排序与会话拖入拖出", async ({ page }) => {
  await openWorkbench(page);
  const suffix = Date.now();
  const firstName = `拖拽项目甲-${suffix}`;
  const secondName = `拖拽项目乙-${suffix}`;
  const threadTitle = `拖拽会话-${suffix}`;
  const first = await createProject(page, firstName);
  const second = await createProject(page, secondName);
  const thread = await createThread(page, threadTitle);
  await page.reload();
  const navigation = page.getByLabel("项目与会话");

  const secondHandle = navigation.getByRole("button", { name: `拖动项目 ${secondName}`, exact: true });
  const firstTarget = navigation.getByTitle(firstName, { exact: true });
  const secondTreeItem = secondHandle.locator('xpath=ancestor::*[@role="treeitem"]');
  await directDrag(page, secondHandle, firstTarget, async () => {
    await expect(page.getByText(secondName, { exact: true })).toHaveCount(2);
    expect(await secondTreeItem.evaluate((element) => window.getComputedStyle(element).opacity)).toBe("0.25");
  });
  await expect.poll(async () => {
    const response = await page.request.get("/api/v1/projects");
    const ids = ((await response.json()) as Array<{ id: string }>).map((project) => project.id);
    return ids.indexOf(second.id) < ids.indexOf(first.id);
  }).toBe(true);

  const threadRow = navigation.locator(`[data-thread-id="${thread.id}"]`);
  const threadHandle = navigation.getByRole("button", { name: `拖动会话 ${threadTitle}`, exact: true });
  await directDrag(page, threadHandle, firstTarget, async () => {
    await expect(page.getByText("移出项目", { exact: true })).toBeVisible();
    expect(await threadRow.evaluate((element) => window.getComputedStyle(element).opacity)).toBe("0.2");
  });
  await expect(threadRow).toHaveAttribute("data-project-id", first.id);
  const movedFrames = await page.evaluate(async (threadId) => {
    const frames: Array<{ count: number; projectIds: string[]; text: string }> = [];
    for (let index = 0; index < 12; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const rows = [...document.querySelectorAll<HTMLElement>(`[data-thread-id="${threadId}"]`)];
      frames.push({ count: rows.length, projectIds: rows.map((row) => row.dataset.projectId || ""), text: rows.map((row) => row.innerText).join("|") });
    }
    return frames;
  }, thread.id);
  expect(movedFrames.every((frame) => frame.count === 1 && frame.projectIds[0] === first.id && frame.text === threadTitle)).toBe(true);
  await expect.poll(async () => {
    const snapshot = await (await page.request.get(`/api/v1/threads/${thread.id}`)).json() as { thread: { projectId: string | null } };
    return snapshot.thread.projectId;
  }).toBe(first.id);

  const nestedHandle = navigation.getByRole("button", { name: `拖动会话 ${threadTitle}`, exact: true });
  const unassignedTarget = navigation.locator('section[aria-labelledby="sessions-heading"]');
  await directDrag(page, nestedHandle, unassignedTarget, async () => {
    await expect(page.getByText("移出项目", { exact: true })).toBeVisible();
  });
  await expect(threadRow).toHaveAttribute("data-project-id", "");
  const exitedFrames = await page.evaluate(async (threadId) => {
    const frames: Array<{ count: number; projectIds: string[] }> = [];
    for (let index = 0; index < 12; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const rows = [...document.querySelectorAll<HTMLElement>(`[data-thread-id="${threadId}"]`)];
      frames.push({ count: rows.length, projectIds: rows.map((row) => row.dataset.projectId || "") });
    }
    return frames;
  }, thread.id);
  expect(exitedFrames.every((frame) => frame.count === 1 && frame.projectIds[0] === "")).toBe(true);
  await expect.poll(async () => {
    const snapshot = await (await page.request.get(`/api/v1/threads/${thread.id}`)).json() as { thread: { projectId: string | null } };
    return snapshot.thread.projectId;
  }).toBeNull();

  const cancelHandle = navigation.getByRole("button", { name: `拖动会话 ${threadTitle}`, exact: true });
  const cancelBox = await cancelHandle.boundingBox();
  expect(cancelBox).not.toBeNull();
  await page.mouse.move(cancelBox!.x + cancelBox!.width / 2, cancelBox!.y + cancelBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(cancelBox!.x + 80, cancelBox!.y, { steps: 8 });
  await expect(page.getByText(threadTitle, { exact: true })).toHaveCount(2);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.getByText(threadTitle, { exact: true })).toHaveCount(1);
  await expect(threadRow).toHaveCSS("opacity", "1");
  expect(await threadRow.evaluate((element) => window.getComputedStyle(element).transitionDuration)).toContain("0.12s");
});

test("项目创建、重命名、会话移动与项目删除", async ({ page }) => {
  await openWorkbench(page);
  const navigation = page.getByLabel("项目与会话");
  const suffix = Date.now();
  const projectName = `浏览器测试项目-${suffix}`;
  const renamedProject = `交互验收项目-${suffix}`;
  const sourceThread = `移动测试会话-${suffix}`;
  await createThread(page, sourceThread);
  await page.reload();

  await page.getByRole("button", { name: "新建项目" }).click();
  const projectInput = page.getByLabel("项目名称");
  await expect(projectInput).toBeVisible();
  const projectFieldMetrics = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>("#project-name")!;
    const label = document.querySelector<HTMLLabelElement>('label[for="project-name"]')!;
    const inputRect = input.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    const style = window.getComputedStyle(input);
    return {
      borderWidth: style.borderWidth,
      outlineStyle: style.outlineStyle,
      boxShadow: style.boxShadow,
      gap: inputRect.top - labelRect.bottom
    };
  });
  expect(projectFieldMetrics).toMatchObject({ borderWidth: "0px", outlineStyle: "none", boxShadow: "none" });
  expect(projectFieldMetrics.gap).toBeGreaterThanOrEqual(7);
  await projectInput.fill(projectName);
  expect(await projectInput.evaluate((input) => {
    const field = input as HTMLInputElement;
    return { start: field.selectionStart, end: field.selectionEnd };
  })).toEqual({ start: projectName.length, end: projectName.length });
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(navigation.getByText(projectName, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: `管理项目 ${projectName}` }).click();
  await page.getByRole("button", { name: "重命名项目", exact: true }).click();
  await page.getByLabel("项目名称").fill(renamedProject);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(navigation.getByText(renamedProject, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: `管理会话 ${sourceThread}` }).click();
  await page.getByRole("button", { name: renamedProject, exact: true }).click();
  const movedThread = page.getByRole("button", { name: `${sourceThread} ${renamedProject}` });
  await expect(movedThread).toBeVisible();

  await page.getByRole("button", { name: "新建会话", exact: true }).first().click();
  await page.getByRole("button", { name: `管理项目 ${renamedProject}` }).click();
  await page.getByRole("button", { name: "删除项目", exact: true }).click();
  await page.getByRole("button", { name: "删除项目", exact: true }).click();
  await expect(navigation.getByText(renamedProject, { exact: true })).toHaveCount(0);
});

test("附件上传与审批拒绝路径", async ({ page }) => {
  await openWorkbench(page);

  const imageName = `界面截图-${Date.now()}.png`;
  await page.getByLabel("选择图片或文档").setInputFiles([
    {
      name: imageName,
      mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9WlS8AAAAASUVORK5CYII=", "base64")
    },
    {
      name: "完整需求说明.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("目标：验证附件上传、发送和展示")
    }
  ]);
  await expect(page.getByLabel("待发送附件").getByRole("img", { name: "已上传图片" })).toBeVisible();
  await expect(page.getByText("完整需求说明.txt", { exact: true })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain(imageName);
  await page.getByLabel("任务输入").fill("请结合附件总结重点");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("img", { name: "已上传图片" })).toBeVisible();
  await expect(page.getByTitle("打开文档 完整需求说明.txt")).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain(imageName);
  await expect(page.getByText(/我已完成「请结合附件总结重点」的第一轮整理/u)).toBeVisible();

  await page.getByLabel("任务输入").fill("请运行代码验证附件内容");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("允许本次执行？", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(page.getByText("已拒绝工具访问", { exact: true })).toBeVisible();
  await expect(page.getByText(/我已整理「请运行代码验证附件内容」的实现草案/u)).toBeVisible();
});

test("移动端布局无横向溢出且工作区可打开", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkbench(page);

  await expect(page.getByLabel("项目与会话")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新建会话" })).toBeVisible();
  await page.getByRole("button", { name: "打开工作区" }).click();
  await expect(page.getByRole("complementary", { name: "工作区", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭工作区" }).click();

  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
});
