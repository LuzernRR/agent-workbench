import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const runnerUrl = pathToFileURL(path.resolve("scripts/run-live-integration.mjs")).href;

function evaluateRunner(expression: string) {
  return spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { normalizeIntegrationDatabaseUrl, selectIntegrationDatabaseUrl } from ${JSON.stringify(runnerUrl)}; ${expression}`
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

function runRunner(integrationDatabaseUrl?: string) {
  const environment = { ...process.env };
  delete environment.WORKBENCH_INTEGRATION_DATABASE_URL;
  if (integrationDatabaseUrl) {
    environment.WORKBENCH_INTEGRATION_DATABASE_URL = integrationDatabaseUrl;
  }
  return spawnSync(process.execPath, [path.resolve("scripts/run-live-integration.mjs")], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8"
  });
}

describe("PostgreSQL integration runner 安全门禁", () => {
  it.each([
    ["127.0.0.1", "postgres://workbench:secret@127.0.0.1:5432/agent_workbench_test", "127.0.0.1", "/agent_workbench_test"],
    ["localhost", "postgresql://workbench:secret@localhost:5432/agent_workbench_integration", "localhost", "/agent_workbench_integration"],
    ["IPv6 loopback", "postgres://workbench:secret@[::1]:5432/agent_workbench_test", "[::1]", "/agent_workbench_test"]
  ])("接受显式专用的 %s 数据库", (_label, configured, hostname, pathname) => {
    const result = evaluateRunner(`
      const url = new URL(normalizeIntegrationDatabaseUrl(${JSON.stringify(configured)}));
      console.log(JSON.stringify({ hostname: url.hostname, pathname: url.pathname }));
    `);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ hostname, pathname });
  });

  it("专用集成变量优先且通用数据库变量不能覆盖它", () => {
    const result = evaluateRunner(`
      const selected = selectIntegrationDatabaseUrl({
        WORKBENCH_INTEGRATION_DATABASE_URL: "postgres://workbench:secret@localhost:16543/agent_workbench_integration",
        WORKBENCH_DATABASE_URL: "postgres://workbench:secret@db.example.com:5432/production"
      });
      const url = new URL(selected);
      console.log(JSON.stringify({ hostname: url.hostname, port: url.port, pathname: url.pathname }));
    `);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      hostname: "localhost",
      port: "16543",
      pathname: "/agent_workbench_integration"
    });
  });

  it("缺少专用变量时拒绝回退到通用数据库配置", () => {
    const result = runRunner();

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /必须显式设置 WORKBENCH_INTEGRATION_DATABASE_URL/u
    );
  });

  it("拒绝非 PostgreSQL 协议", () => {
    const result = evaluateRunner(
      'normalizeIntegrationDatabaseUrl("https://localhost/agent_workbench_test")'
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/仅允许 PostgreSQL 连接 URL/u);
  });

  it("畸形 URL 使用脱敏错误且不泄露密码", () => {
    const secret = "runner-secret-must-not-leak";
    const result = runRunner(
      `postgresql://workbench:${secret}@[::1/agent_workbench_test`
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toMatch(/数据库 URL 格式无效/u);
    expect(output).not.toContain(secret);
  });

  it.each([
    ["host query", "?host=remote.example.com"],
    ["port query", "?port=6543"],
    ["database query", "?database=production"],
    ["fragment", "#production"]
  ])("拒绝 %s 覆盖 PostgreSQL 连接目标", (_label, suffix) => {
    const result = evaluateRunner(
      `normalizeIntegrationDatabaseUrl("postgres://workbench:secret@localhost:5432/agent_workbench_test${suffix}")`
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /不允许 query 或 fragment 覆盖连接目标/u
    );
  });

  it.each(["db.example.com", "postgres"])(
    "专用变量指向非 loopback 主机 %s 时在启动 Vitest 前拒绝",
    (hostname) => {
      const result = runRunner(
        `postgres://workbench:secret@${hostname}:5432/agent_workbench_test`
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/仅允许 loopback PostgreSQL/u);
    }
  );

  it.each(["postgres", "template0", "template1", "agent_workbench", "shared_dev"])(
    "本地非专用数据库 %s 在启动 Vitest 前被拒绝",
    (databaseName) => {
      const result = runRunner(
        `postgres://workbench:secret@localhost:5432/${databaseName}`
      );

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(
        /仅允许名称以 _test 或 _integration 结尾的专用数据库/u
      );
    }
  );
});
