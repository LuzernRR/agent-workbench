import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyThreadState } from "@/lib/agent-events/reducer";
import type { ThreadSnapshot } from "@/lib/agent-events/types";
import { useAgentThread } from "./use-agent-thread";

const startRunDeferred = () => {
  let resolve!: (value: { runId: string }) => void;
  const promise = new Promise<{ runId: string }>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

function snapshot(): ThreadSnapshot {
  return {
    project: null,
    thread: {
      id: "thread-live",
      projectId: null,
      title: "测试会话",
      updatedAt: "2026-08-07T00:00:00.000Z",
      status: "idle"
    },
    state: createEmptyThreadState(null, "thread-live")
  };
}

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return {
    ...actual,
    workbenchApi: {
      ...actual.workbenchApi,
      thread: vi.fn(async () => snapshot()),
      startRun: vi.fn()
    }
  };
});

class FakeEventSource {
  static readonly CLOSED = 2;
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  readyState = FakeEventSource.OPEN;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  addEventListener() {}
  close() {}
}

vi.stubGlobal("EventSource", FakeEventSource);

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function QueryWrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useAgentThread optimistic run timing", () => {
  it("records the send timestamp before the start request resolves", async () => {
    const deferred = startRunDeferred();
    const { workbenchApi } = await import("@/lib/api/client");
    vi.mocked(workbenchApi.startRun).mockReturnValueOnce(deferred.promise);
    const hook = renderHook(() => useAgentThread("thread-live"), { wrapper: wrapper() });

    await waitFor(() => expect(hook.result.current.state?.threadId).toBe("thread-live"));

    let request!: Promise<unknown>;
    act(() => {
      request = hook.result.current.startRun("首条请求");
    });
    expect(hook.result.current.isStarting).toBe(true);
    expect(hook.result.current.pendingStartedAt).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    const pendingStartedAt = hook.result.current.pendingStartedAt;

    await act(async () => {
      deferred.resolve({ runId: "run-live" });
      await request;
    });

    expect(hook.result.current.state).toMatchObject({
      activeRunId: "run-live",
      runStatus: "running",
      runTimings: { "run-live": { startedAt: pendingStartedAt } }
    });
    expect(hook.result.current.pendingStartedAt).toBeNull();
  });
});
