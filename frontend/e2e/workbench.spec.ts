import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

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

test("首页、中文模型与高密度工作台布局", async ({ page }) => {
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
  await expect(page.getByRole("button", { name: "旗舰模型", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "快速模型", exact: true }).click();
  await expect(page.getByRole("button", { name: "选择模型" })).toHaveAttribute("title", "快速模型");

  await page.getByRole("button", { name: "折叠左栏" }).click();
  await expect(page.getByRole("button", { name: "展开左栏" })).toBeVisible();
  await page.getByRole("button", { name: "展开左栏" }).click();
  await expect(page.getByLabel("项目与会话")).toBeVisible();

  const visibleText = await page.locator("body").innerText();
  expect(visibleText).not.toMatch(/万能搜索|出海选品|企业知识库/u);
  expect(visibleText).not.toMatch(/\.\.\.|…/u);
});

test("流式任务、工具、审批、计划、成果、文件、代码与日志", async ({ page }) => {
  await openWorkbench(page);

  await page.getByLabel("任务输入").fill("请运行代码实现一个任务面板页面，并整理方案文档");
  await page.getByRole("button", { name: "发送", exact: true }).click();

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
});

test("运行可停止并恢复发送状态", async ({ page }) => {
  await openWorkbench(page);
  const threadTitle = `停止交互测试-${Date.now()}`;
  await createThread(page, threadTitle);
  await page.reload();
  await page.getByText(threadTitle, { exact: true }).click();
  await page.getByLabel("任务输入").fill("请整理一份详细的计划文档");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const stopButton = page.getByRole("button", { name: "停止执行" });
  await expect(stopButton).toBeVisible();
  await stopButton.click();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "编辑最新消息" }).click();
  await page.getByLabel("编辑当前消息").fill("请整理一个更精简的计划");
  await page.getByRole("button", { name: "发送修改" }).click();
  await expect(page.getByRole("button", { name: "停止执行" })).toBeVisible();
  await page.getByRole("button", { name: "停止执行" }).click();
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
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

test("项目创建、重命名、会话移动与项目删除", async ({ page }) => {
  await openWorkbench(page);
  const suffix = Date.now();
  const projectName = `浏览器测试项目-${suffix}`;
  const renamedProject = `交互验收项目-${suffix}`;
  const sourceThread = `移动测试会话-${suffix}`;
  await createThread(page, sourceThread);
  await page.reload();

  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByLabel("项目名称").fill(projectName);
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(page.getByText(projectName, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: `管理项目 ${projectName}` }).click();
  await page.getByRole("button", { name: "重命名项目", exact: true }).click();
  await page.getByLabel("项目名称").fill(renamedProject);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText(renamedProject, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: `管理会话 ${sourceThread}` }).click();
  await page.getByRole("button", { name: renamedProject, exact: true }).click();
  const movedThread = page.getByRole("button", { name: `${sourceThread} ${renamedProject}` });
  await expect(movedThread).toBeVisible();

  await page.getByRole("button", { name: "新建会话", exact: true }).first().click();
  await page.getByRole("button", { name: `管理项目 ${renamedProject}` }).click();
  await page.getByRole("button", { name: "删除项目", exact: true }).click();
  await page.getByRole("button", { name: "删除项目", exact: true }).click();
  await expect(page.getByText(renamedProject, { exact: true })).toHaveCount(0);
});

test("附件上传与审批拒绝路径", async ({ page }) => {
  await openWorkbench(page);

  await page.getByLabel("选择图片或文档").setInputFiles({
    name: "完整需求说明.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("目标：验证附件上传、发送和展示")
  });
  await expect(page.getByText("完整需求说明.txt", { exact: true })).toBeVisible();
  await page.getByLabel("任务输入").fill("请结合附件总结重点");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByTitle("打开文档 完整需求说明.txt")).toBeVisible();
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
