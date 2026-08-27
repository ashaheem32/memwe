import pg from "pg";

const { Pool } = pg;

// pgvector round-trips as a string; parse it once, here, not at 40 call sites.
const VECTOR_OID_QUERY = `select oid from pg_type where typname = 'vector'`;

/**
 * Owner pool. Bypasses RLS. Migrations, workers, metering — anything that
 * legitimately works across tenants. Never use it for a request.
 */
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://memwe:memwe@localhost:5432/memwe",
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
});

/**
 * App pool. Connects as `memwe_app`, which has FORCE'd row level security
 * and exactly one policy. Every request-scoped read goes through this,
 * via withTenant(). This is the isolation boundary — not your WHERE clause.
 */
export const appPool = new Pool({
  connectionString:
    process.env.APP_DATABASE_URL ?? "postgres://memwe_app:memwe_app@localhost:5432/memwe",
  max: Number(process.env.PG_APP_POOL_MAX ?? 20),
  idleTimeoutMillis: 30_000,
});

let vectorParserInstalled = false;
export async function installVectorParser(): Promise<void> {
  if (vectorParserInstalled) return;
  const { rows } = await pool.query<{ oid: number }>(VECTOR_OID_QUERY);
  const oid = rows[0]?.oid;
  if (oid) pg.types.setTypeParser(oid, (v) => (v === null ? null : JSON.parse(v)));
  vectorParserInstalled = true;
}

export type Tenant = { orgId: string; container?: string };

/**
 * Run a callback inside a transaction with the tenant GUCs set, so RLS
 * applies. Every request-scoped read goes through this. If you find
 * yourself using `pool.query` directly for tenant data, that's the bug.
 */
export async function withTenant<T>(
  tenant: Tenant,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.org_id', $1, true)", [tenant.orgId]);
    if (tenant.container) {
      await client.query("select set_config('app.container', $1, true)", [tenant.container]);
    }
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Admin path — bypasses tenant GUCs. Migrations, workers, metering only. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function close(): Promise<void> {
  await Promise.allSettled([pool.end(), appPool.end()]);
}

export type { PoolClient } from "pg";
