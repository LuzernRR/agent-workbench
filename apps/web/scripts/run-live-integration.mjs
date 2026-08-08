import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const loopbackDatabaseHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const dedicatedDatabaseNamePattern = /^[a-z0-9][a-z0-9_-]*_(?:test|integration)$/iu;

export function normalizeIntegrationDatabaseUrl(configured) {
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("Live integration 数据库 URL 格式无效");
  }
  if (url.search || url.hash) {
    throw new Error("Live integration 数据库 URL 不允许 query 或 fragment 覆盖连接目标");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
    throw new Error("Live integration 仅允许 PostgreSQL 连接 URL");
  }
  if (!loopbackDatabaseHosts.has(url.hostname.toLowerCase())) {
    throw new Error("Live integration 仅允许 loopback PostgreSQL，拒绝修改远程数据库");
  }
  let databaseName;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error("Live integration 数据库名称不是有效的 URL 路径");
  }
  if (!dedicatedDatabaseNamePattern.test(databaseName)) {
    throw new Error(
      "Live integration 仅允许名称以 _test 或 _integration 结尾的专用数据库"
    );
  }
  return url.toString();
}

export function selectIntegrationDatabaseUrl(environment) {
  const environmentUrl = environment.WORKBENCH_INTEGRATION_DATABASE_URL?.trim();
  if (!environmentUrl) {
    throw new Error(
      "Live integration 必须显式设置 WORKBENCH_INTEGRATION_DATABASE_URL"
    );
  }
  return normalizeIntegrationDatabaseUrl(environmentUrl);
}

function localEnvironment() {
  return {
    WORKBENCH_DATABASE_URL: selectIntegrationDatabaseUrl(process.env)
  };
}

const integrationFiles = [
  "src/server/persistence/schema.integration.test.ts",
  "src/server/live/store.integration.test.ts",
  "src/server/live/handler.integration.test.ts",
  "src/server/live/event-outbox.integration.test.ts",
  "src/server/live/checkpoint-batches.integration.test.ts",
  "src/server/live/authorization.integration.test.ts"
];

function runIntegrationFiles() {
  const environment = {
    ...process.env,
    ...localEnvironment(),
    WORKBENCH_DATABASE_SSL: process.env.WORKBENCH_DATABASE_SSL || "false",
    WORKBENCH_LIVE_INTEGRATION: "1"
  };
  const vitest = resolve(appRoot, "node_modules", "vitest", "vitest.mjs");

  for (const file of integrationFiles) {
    const result = spawnSync(process.execPath, [vitest, "run", file], {
      cwd: appRoot,
      env: environment,
      stdio: "inherit"
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runIntegrationFiles();
}
