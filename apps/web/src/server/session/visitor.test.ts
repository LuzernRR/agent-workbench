import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/server/persistence/database", () => database);

import { configuredDefaultTenant, DEFAULT_TENANT_ID, resolveVisitor, VisitorSessionError } from "./visitor";

const token = `wbv_${"a".repeat(43)}`;

function request(cookie?: string) {
  return new Request("http://localhost/api/v1/threads", {
    headers: cookie ? { cookie } : {}
  });
}

describe("访客租户派生", () => {
  const original = process.env.WORKBENCH_TENANT;

  beforeEach(() => {
    database.query.mockReset();
    database.query.mockResolvedValue({ rowCount: 1, rows: [{ id: "visitor-one", tenant_id: "tenant-stored" }] });
  });

  afterEach(() => {
    if (original === undefined) delete process.env.WORKBENCH_TENANT;
    else process.env.WORKBENCH_TENANT = original;
  });

  it("租户来自数据库行而不是请求字段", async () => {
    const principal = await resolveVisitor(request(`workbench_visitor=${token}`));
    expect(principal).toEqual({ id: "visitor-one", tenantId: "tenant-stored" });
  });

  it("请求携带伪造 tenant 头与 cookie 时一律忽略", async () => {
    const forged = new Request("http://localhost/api/v1/threads", {
      headers: {
        cookie: `workbench_visitor=${token}; tenant_id=attacker`,
        "x-tenant-id": "attacker"
      }
    });
    const principal = await resolveVisitor(forged);
    expect(principal.tenantId).toBe("tenant-stored");
    const values = database.query.mock.calls[0]?.[1] as unknown[];
    expect(values).not.toContain("attacker");
  });

  it("缺少或非法访客令牌时 fail-closed，不落库", async () => {
    await expect(resolveVisitor(request())).rejects.toBeInstanceOf(VisitorSessionError);
    await expect(resolveVisitor(request("workbench_visitor=short"))).rejects.toBeInstanceOf(VisitorSessionError);
    expect(database.query).not.toHaveBeenCalled();
  });

  it("已存在会话在环境租户变更后仍保留原租户", async () => {
    process.env.WORKBENCH_TENANT = "tenant-new";
    const principal = await resolveVisitor(request(`workbench_visitor=${token}`));
    expect(principal.tenantId).toBe("tenant-stored");
    const sql = String(database.query.mock.calls[0]?.[0]);
    expect(sql).toContain("DO UPDATE SET last_seen_at = now()");
    expect(sql).not.toContain("SET tenant_id");
  });

  it("令牌以哈希存储，明文不入库", async () => {
    await resolveVisitor(request(`workbench_visitor=${token}`));
    const values = database.query.mock.calls[0]?.[1] as unknown[];
    expect(values).not.toContain(token);
    expect(String(values?.[1])).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("非法配置租户回落到默认值而不是写入违反约束的值", () => {
    process.env.WORKBENCH_TENANT = "bad tenant!";
    expect(configuredDefaultTenant()).toBe(DEFAULT_TENANT_ID);
    process.env.WORKBENCH_TENANT = "a".repeat(65);
    expect(configuredDefaultTenant()).toBe(DEFAULT_TENANT_ID);
    process.env.WORKBENCH_TENANT = "  ";
    expect(configuredDefaultTenant()).toBe(DEFAULT_TENANT_ID);
  });

  it("合法配置租户用于新建会话", () => {
    process.env.WORKBENCH_TENANT = "tenant-b_2";
    expect(configuredDefaultTenant()).toBe("tenant-b_2");
  });
});
