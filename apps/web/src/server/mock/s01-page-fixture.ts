import type { S01ProcessFixtureCatalog } from "@/lib/agent-events/v2/process-view-model";

export function isS01PreviewEnabled() {
  return process.env.WORKBENCH_LLM_MODE === "mock";
}
export async function loadS01PageFixture(
  requestedScenario: string | string[] | undefined
): Promise<S01ProcessFixtureCatalog | null> {
  if (!isS01PreviewEnabled()) return null;
  const { createS01ProcessFixtureCatalog } = await import("./s01-event-fixtures");
  const scenario = Array.isArray(requestedScenario) ? requestedScenario[0] : requestedScenario;
  return createS01ProcessFixtureCatalog(scenario);
}
