import { describe, expect, it } from "vitest";
import { WORKBENCH_SCHEMA_SQL } from "./schema";

describe("工作台数据库结构", () => {
  it("项目记忆按访客和项目隔离并保留 pgvector 扩展位", () => {
    expect(WORKBENCH_SCHEMA_SQL).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(WORKBENCH_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS wb_project_memories");
    expect(WORKBENCH_SCHEMA_SQL).toContain("FOREIGN KEY (project_id, visitor_id) REFERENCES wb_projects(id, visitor_id) ON DELETE CASCADE");
    expect(WORKBENCH_SCHEMA_SQL).toContain("embedding vector");
    expect(WORKBENCH_SCHEMA_SQL).toContain("source_thread_title text NOT NULL");
    expect(WORKBENCH_SCHEMA_SQL).toContain("wb_project_memories_content_nonempty");
    expect(WORKBENCH_SCHEMA_SQL).not.toContain("BETWEEN 1 AND 8000");
    expect(WORKBENCH_SCHEMA_SQL).toContain("WHERE archived_at IS NULL");
  });

  it("原始会话的运行、事件和附件通过外键级联清理", () => {
    expect(WORKBENCH_SCHEMA_SQL).toContain("FOREIGN KEY (thread_id, visitor_id) REFERENCES wb_threads(id, visitor_id) ON DELETE CASCADE");
  });

  it("运行表具备持久队列、heartbeat 与单调 fencing 字段", () => {
    expect(WORKBENCH_SCHEMA_SQL).toContain("execution_input jsonb NOT NULL");
    expect(WORKBENCH_SCHEMA_SQL).toContain("available_at timestamptz NOT NULL");
    expect(WORKBENCH_SCHEMA_SQL).toContain("lease_owner text");
    expect(WORKBENCH_SCHEMA_SQL).toContain("lease_epoch bigint NOT NULL DEFAULT 0");
    expect(WORKBENCH_SCHEMA_SQL).toContain("lease_expires_at timestamptz");
    expect(WORKBENCH_SCHEMA_SQL).toContain("heartbeat_at timestamptz");
    expect(WORKBENCH_SCHEMA_SQL).toContain("worker_attempt integer NOT NULL DEFAULT 0");
    expect(WORKBENCH_SCHEMA_SQL).toContain("wb_runs_lease_epoch_nonnegative");
    expect(WORKBENCH_SCHEMA_SQL).toContain("wb_runs_worker_attempt_nonnegative");
    expect(WORKBENCH_SCHEMA_SQL).toContain("CREATE INDEX IF NOT EXISTS wb_runs_claim_idx");
  });
});
