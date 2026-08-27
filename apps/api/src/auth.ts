import { createHash } from "node:crypto";
import * as cache from "@memwe/cache";
import { MemweError } from "@memwe/contracts";
import { pool } from "@memwe/db";

export type Principal = { orgId: string; keyId: string; containerScope: string | null };

const TTL_SECONDS = 300;

/** Never key the cache on the raw secret. */
function cacheKey(key: string): string {
  return `apikey:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

/**
 * API key lookup: prefix-indexed, then a hash compare, then cached in
 * Redis so every API instance shares one answer. The cache degrades to
 * in-process if Redis is down — see @memwe/cache.
 */
export async function authenticate(header: string | undefined): Promise<Principal> {
  const key = header?.replace(/^Bearer\s+/i, "").trim();
  if (!key) throw new MemweError("unauthorized", "missing Authorization header");

  const ck = cacheKey(key);
  const cached = await cache.get(ck);
  if (cached) return JSON.parse(cached) as Principal;

  const prefix = key.slice(0, 11);
  const hash = createHash("sha256").update(key).digest();

  const { rows } = await pool.query<{
    id: string;
    org_id: string;
    container_scope: string | null;
    ok: boolean;
  }>(
    `select id::text, org_id::text, container_scope, (hash = $2) as ok
       from api_keys where prefix = $1 and revoked_at is null`,
    [prefix, hash],
  );

  const row = rows[0];
  if (!row?.ok) throw new MemweError("unauthorized", "invalid API key");

  const p: Principal = { orgId: row.org_id, keyId: row.id, containerScope: row.container_scope };
  await cache.set(ck, JSON.stringify(p), TTL_SECONDS);
  void pool.query(`update api_keys set last_used_at = now() where id = $1`, [row.id]);
  return p;
}

/**
 * Revoking a key must stop it working everywhere at once, not after each
 * instance's TTL happens to lapse. This is why the cache is shared.
 */
export async function revoke(key: string): Promise<void> {
  await cache.del(cacheKey(key));
}

/** Container tags are an authorization boundary, not just a namespace. */
export function assertContainerAllowed(p: Principal, container: string): void {
  if (p.containerScope && !container.startsWith(p.containerScope)) {
    throw new MemweError("forbidden", `key is scoped to '${p.containerScope}'`);
  }
}
