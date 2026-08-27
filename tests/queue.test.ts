import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, close } from "@memwe/db";
import { PgQueue } from "../apps/worker/src/queue.js";

const q = new PgQueue();
const env = {
  orgId: "11111111-1111-1111-1111-111111111111",
  container: "test_queue",
  traceId: "t-test",
};

beforeEach(async () => {
  await pool.query("delete from jobs where type = 'document.accept'");
});

afterAll(async () => {
  await pool.query("delete from jobs where type = 'document.accept'");
  await close();
});

describe("PgQueue", () => {
  it("enqueues and claims", async () => {
    const id = await q.enqueue({ type: "document.accept", payload: env, traceId: env.traceId });
    expect(id).toBeTruthy();

    const [job] = await q.claim("w1", 10);
    expect(job?.id).toBe(id);
    expect(job?.attempts).toBe(1);
    expect(job?.traceId).toBe("t-test");
  });

  it("does not hand the same job to two workers", async () => {
    await q.enqueue({ type: "document.accept", payload: env, traceId: env.traceId });

    const [a, b] = await Promise.all([q.claim("w1", 10), q.claim("w2", 10)]);
    expect(a.length + b.length).toBe(1);
  });

  it("dedupes on dedupeKey while a job is live", async () => {
    const first = await q.enqueue({
      type: "document.accept", payload: env, traceId: env.traceId, dedupeKey: "dk-1",
    });
    const second = await q.enqueue({
      type: "document.accept", payload: env, traceId: env.traceId, dedupeKey: "dk-1",
    });
    expect(first).toBeTruthy();
    expect(second).toBeNull();
  });

  it("retry schedules into the future and does not claim early", async () => {
    const id = await q.enqueue({ type: "document.accept", payload: env, traceId: env.traceId });
    await q.claim("w1", 1);
    await q.retry(id!, "boom", 60_000);

    expect(await q.claim("w1", 10)).toHaveLength(0);

    const { rows } = await pool.query<{ status: string; last_error: string }>(
      "select status::text, last_error from jobs where id=$1", [id],
    );
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.last_error).toBe("boom");
  });

  it("reaps jobs whose worker stopped heartbeating", async () => {
    const id = await q.enqueue({ type: "document.accept", payload: env, traceId: env.traceId });
    await q.claim("w1", 1);
    await pool.query("update jobs set heartbeat_at = now() - interval '10 minutes' where id=$1", [id]);

    expect(await q.reap(60_000)).toBe(1);
    expect(await q.claim("w2", 10)).toHaveLength(1);
  });

  it("dead-letters instead of reviving once attempts are exhausted", async () => {
    const id = await q.enqueue({
      type: "document.accept", payload: env, traceId: env.traceId, maxAttempts: 1,
    });
    await q.claim("w1", 1);
    await pool.query("update jobs set heartbeat_at = now() - interval '10 minutes' where id=$1", [id]);
    await q.reap(60_000);

    const { rows } = await pool.query<{ status: string }>(
      "select status::text from jobs where id=$1", [id],
    );
    expect(rows[0]?.status).toBe("dead");
  });
});
