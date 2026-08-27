import { Redis } from "ioredis";

/**
 * Shared cache. Two rules:
 *
 * 1. It degrades. A Redis outage must never take down authentication —
 *    every call falls back to an in-process map and logs once. Losing the
 *    cache should cost latency, not availability.
 * 2. It is not a database. Anything here must be reconstructible from
 *    Postgres.
 */

const URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let client: Redis | null = null;
let degraded = false;
const fallback = new Map<string, { v: string; exp: number }>();

function connect(): Redis | null {
  if (client || degraded) return client;
  try {
    client = new Redis(URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      // Fail fast rather than queueing commands while Redis is down —
      // a queued auth lookup is worse than a cache miss.
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 200, 3000),
    });
    client.on("error", (err) => {
      if (!degraded) {
        degraded = true;
        process.stderr.write(
          `${JSON.stringify({
            level: "warn",
            svc: "cache",
            msg: "redis unavailable, falling back to in-process cache",
            err: err.message,
          })}\n`,
        );
      }
    });
    client.on("ready", () => {
      degraded = false;
    });
    return client;
  } catch {
    degraded = true;
    return null;
  }
}

function sweep(): void {
  const now = Date.now();
  for (const [k, e] of fallback) if (e.exp < now) fallback.delete(k);
}

export async function get(key: string): Promise<string | null> {
  const c = connect();
  if (c && !degraded) {
    try {
      return await c.get(key);
    } catch {
      /* fall through */
    }
  }
  sweep();
  const hit = fallback.get(key);
  return hit && hit.exp > Date.now() ? hit.v : null;
}

export async function set(key: string, value: string, ttlSeconds: number): Promise<void> {
  const c = connect();
  if (c && !degraded) {
    try {
      await c.set(key, value, "EX", ttlSeconds);
      return;
    } catch {
      /* fall through */
    }
  }
  fallback.set(key, { v: value, exp: Date.now() + ttlSeconds * 1000 });
}

/**
 * Revocation. This is the reason the cache is shared rather than
 * per-process: a revoked API key must stop working everywhere at once,
 * not after each instance's TTL happens to lapse.
 */
export async function del(key: string): Promise<void> {
  const c = connect();
  if (c && !degraded) {
    try {
      await c.del(key);
    } catch {
      /* fall through */
    }
  }
  fallback.delete(key);
}

export async function ping(): Promise<boolean> {
  const c = connect();
  if (!c || degraded) return false;
  try {
    return (await c.ping()) === "PONG";
  } catch {
    return false;
  }
}

export async function close(): Promise<void> {
  if (client) {
    await client.quit().catch(() => client?.disconnect());
    client = null;
  }
}
