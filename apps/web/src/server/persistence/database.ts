import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { loadRuntimeConfig, requireDatabaseConfig } from "@/server/config/runtime-config";
import { WORKBENCH_SCHEMA_SQL } from "./schema";

type DatabaseGlobal = {
  __workbenchPool?: Pool;
  __workbenchSchemaPromise?: Promise<void>;
  __workbenchDatabaseUrl?: string;
};

const databaseGlobal = globalThis as unknown as DatabaseGlobal;

async function pool() {
  const config = requireDatabaseConfig(await loadRuntimeConfig());
  if (!databaseGlobal.__workbenchPool || databaseGlobal.__workbenchDatabaseUrl !== config.url) {
    await databaseGlobal.__workbenchPool?.end();
    databaseGlobal.__workbenchPool = new Pool({
      connectionString: config.url,
      max: config.poolMax,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      ssl: config.ssl ? { rejectUnauthorized: true } : false
    });
    databaseGlobal.__workbenchDatabaseUrl = config.url;
    databaseGlobal.__workbenchSchemaPromise = undefined;
  }
  return databaseGlobal.__workbenchPool;
}

export async function ensureWorkbenchSchema() {
  if (!databaseGlobal.__workbenchSchemaPromise) {
    databaseGlobal.__workbenchSchemaPromise = (async () => {
      const activePool = await pool();
      const client = await activePool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('agent-workbench-schema-v1'))");
        await client.query(WORKBENCH_SCHEMA_SQL);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        databaseGlobal.__workbenchSchemaPromise = undefined;
        throw error;
      } finally {
        client.release();
      }
    })();
  }
  await databaseGlobal.__workbenchSchemaPromise;
}

export async function query<Row extends QueryResultRow>(text: string, values: unknown[] = []) {
  await ensureWorkbenchSchema();
  return (await pool()).query<Row>(text, values);
}

export async function transaction<T>(operation: (client: PoolClient) => Promise<T>) {
  await ensureWorkbenchSchema();
  const client = await (await pool()).connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
