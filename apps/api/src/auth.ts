import { createHash } from "node:crypto";
import { pool } from "@memwe/db";
import { MemweError } from "@memwe/contracts";

export type Principal = { orgId: string; keyId: string; containerScope: string | null };

const cache = new Map<string, { p: Principal; exp: number }>();
const TTL_MS = 30_000;

/**
 * API key lookup: prefix-indexed, then constant-work hash compare.
 * Cached briefly in-process — Redis in Sprint 1, but a 30s memo already
 * takes this off the hot path.
 */
export async function authenticate(header: string | undefined): Promise<Principal> {
  const key = header?.replace(/^Bearer\s+/i, "").trim();
  if (!key) throw new MemweError("unauthorized", "missing Authorization header");

  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.p;

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
  cache.set(key, { p, exp: Date.now() + TTL_MS });
  void pool.query(`update api_keys set last_used_at = now() where id = $1`, [row.id]);
  return p;
}

/** Container tags are an authorization boundary, not just a namespace. */
export function assertContainerAllowed(p: Principal, container: string): void {
  if (p.containerScope && !container.startsWith(p.containerScope)) {
    throw new MemweError("forbidden", `key is scoped to '${p.containerScope}'`);
  }
}
