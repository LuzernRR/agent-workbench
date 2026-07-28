import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { S01_PROCESS_SCENARIOS } from "@/lib/agent-events/v2/process-view-model";
import {
  isS01PreviewEnabled,
  loadS01PageFixture
} from "./s01-page-fixture";

const originalMode = process.env.WORKBENCH_LLM_MODE;

afterEach(() => {
  if (originalMode === undefined) delete process.env.WORKBENCH_LLM_MODE;
  else process.env.WORKBENCH_LLM_MODE = originalMode;
});

describe("S01 mock-only page fixture", () => {
  it("does not load or expose a fixture in live mode", async () => {
    process.env.WORKBENCH_LLM_MODE = "live";

    expect(isS01PreviewEnabled()).toBe(false);
    await expect(loadS01PageFixture("complex")).resolves.toBeNull();
  });

  it.each(S01_PROCESS_SCENARIOS)(
    "loads the %s scenario only in mock mode",
    async (scenario) => {
      process.env.WORKBENCH_LLM_MODE = "mock";

      const catalog = await loadS01PageFixture(scenario);

      expect(catalog?.source).toBe("fixture");
      expect(catalog?.mode).toBe("mock");
      expect(catalog?.selectedScenario).toBe(scenario);
      expect(Object.keys(catalog?.states ?? {})).toEqual([...S01_PROCESS_SCENARIOS]);
    }
  );

  it("keeps existing production pages free of S01 fixture imports and cache changes", () => {
    const productionPages = [
      "src/app/page.tsx",
      "src/app/workbench/page.tsx",
      "src/app/workbench/p/[projectId]/page.tsx",
      "src/app/workbench/t/[threadId]/page.tsx"
    ];

    for (const relativePath of productionPages) {
      const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
      expect(source).not.toContain("s01-page-fixture");
      expect(source).not.toContain("s01ProcessFixture");
      expect(source).not.toContain("force-dynamic");
    }
  });

  it("guards the additive preview route before loading mock fixtures", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/app/workbench/s01-preview/page.tsx"),
      "utf8"
    );

    expect(source).toContain('export const dynamic = "force-dynamic"');
    expect(source).toContain("if (!isS01PreviewEnabled()) notFound()");
    expect(source.indexOf("if (!isS01PreviewEnabled()) notFound()")).toBeLessThan(
      source.indexOf("loadS01PageFixture(query.s01)")
    );
  });
});
