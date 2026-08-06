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

  it("checkpoint 权威引用、source inbox 与 event outbox 由数据库约束", () => {
    expect(WORKBENCH_SCHEMA_SQL).toContain("revision bigint NOT NULL DEFAULT 0");
    expect(WORKBENCH_SCHEMA_SQL).toContain("checkpoint_id text");
    expect(WORKBENCH_SCHEMA_SQL).toContain("checkpoint_session_id text");
    expect(WORKBENCH_SCHEMA_SQL).toContain("checkpoint_ns text");
    expect(WORKBENCH_SCHEMA_SQL).toContain("checkpoint_step bigint");
    expect(WORKBENCH_SCHEMA_SQL).toContain("wb_runs_revision_nonnegative");
    expect(WORKBENCH_SCHEMA_SQL).toContain("wb_runs_checkpoint_reference_complete");
    expect(WORKBENCH_SCHEMA_SQL).toContain("wb_runs_checkpoint_id_valid");
    expect(WORKBENCH_SCHEMA_SQL).toContain("wb_runs_checkpoint_authority");
    expect(WORKBENCH_SCHEMA_SQL).toContain("wb_runs_revision_monotonic");
    expect(WORKBENCH_SCHEMA_SQL).toContain("FROM pg_trigger");
    expect(WORKBENCH_SCHEMA_SQL).not.toContain("DROP TRIGGER IF EXISTS wb_runs_revision_monotonic");

    expect(WORKBENCH_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS wb_checkpoint_commits");
    expect(WORKBENCH_SCHEMA_SQL).toContain("PRIMARY KEY (run_id, checkpoint_id)");
    expect(WORKBENCH_SCHEMA_SQL).toContain("UNIQUE (run_id, revision)");
    expect(WORKBENCH_SCHEMA_SQL).toContain("UNIQUE (run_id, revision, checkpoint_id)");
    expect(WORKBENCH_SCHEMA_SQL).toContain("wb_checkpoint_commits_revision_positive");
    expect(WORKBENCH_SCHEMA_SQL).toContain("wb_checkpoint_commits_step_valid");
    expect(WORKBENCH_SCHEMA_SQL).toContain("wb_checkpoint_commits_checkpoint_session_id_valid");
    expect(WORKBENCH_SCHEMA_SQL).toContain("wb_checkpoint_commits_checkpoint_ns_valid");

    expect(WORKBENCH_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS wb_source_event_inbox");
    expect(WORKBENCH_SCHEMA_SQL).toContain("PRIMARY KEY (run_id, source_event_id)");
    expect(WORKBENCH_SCHEMA_SQL).toContain("UNIQUE (run_id, source_stream_id, source_stream_seq)");
    expect(WORKBENCH_SCHEMA_SQL).toContain("FOREIGN KEY (run_id, checkpoint_id) REFERENCES wb_checkpoint_commits(run_id, checkpoint_id)");

    expect(WORKBENCH_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS wb_agent_event_outbox");
    expect(WORKBENCH_SCHEMA_SQL).toContain("attempts integer NOT NULL DEFAULT 0");
    expect(WORKBENCH_SCHEMA_SQL).toContain("wb_agent_event_outbox_attempts_nonnegative");
    expect(WORKBENCH_SCHEMA_SQL).toContain("wb_agent_events_outbox_identity");
    expect(WORKBENCH_SCHEMA_SQL).toContain("CREATE INDEX IF NOT EXISTS wb_agent_event_outbox_pending_idx");
  });
});
