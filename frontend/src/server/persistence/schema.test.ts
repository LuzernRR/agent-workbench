import { describe, expect, it } from "vitest";
import { WORKBENCH_SCHEMA_SQL } from "./schema";

describe("工作台数据库结构", () => {
  it("项目记忆按访客和项目隔离并保留 pgvector 扩展位", () => {
    expect(WORKBENCH_SCHEMA_SQL).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(WORKBENCH_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS wb_project_memories");
    expect(WORKBENCH_SCHEMA_SQL).toContain("FOREIGN KEY (project_id, visitor_id) REFERENCES wb_projects(id, visitor_id) ON DELETE CASCADE");
    expect(WORKBENCH_SCHEMA_SQL).toContain("embedding vector");
    expect(WORKBENCH_SCHEMA_SQL).toContain("WHERE archived_at IS NULL");
  });

  it("原始会话的运行、事件和附件通过外键级联清理", () => {
    expect(WORKBENCH_SCHEMA_SQL).toContain("FOREIGN KEY (thread_id, visitor_id) REFERENCES wb_threads(id, visitor_id) ON DELETE CASCADE");
  });
});
