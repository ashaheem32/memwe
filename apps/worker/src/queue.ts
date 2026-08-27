import type { Job, JobType } from "@memwe/contracts";
import { pool } from "@memwe/db";

/**
 * The queue interface. Everything the runner uses lives here, so
 * swapping the Postgres implementation for pgmq or SQS later is one
 * file and no call-site changes.
 */
export interface Queue {
  enqueue(input: EnqueueInput): Promise<string | null>;
  claim(workerId: string, limit: number): Promise<Job[]>;
  complete(id: string): Promise<void>;
  retry(id: string, error: string, delayMs: number): Promise<void>;
  kill(id: string, error: string): Promise<void>;
  heartbeat(ids: string[]): Promise<void>;
  reap(staleAfterMs: number): Promise<number>;
  depth(): Promise<{ pending: number; running: number; dead: number }>;
}

export type EnqueueInput = {
  type: JobType;
  payload: Record<string, unknown>;
  traceId: string;
  /** At most one live job per (type, dedupeKey). Returns null if deduped. */
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts?: number;
};

type JobRow = {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  trace_id: string | null;
};

export class PgQueue implements Queue {
  async enqueue(input: EnqueueInput): Promise<string | null> {
    const { rows } = await pool.query<{ id: string }>(
      `insert into jobs (type, payload, trace_id, dedupe_key, run_at, max_attempts)
       values ($1, $2, $3, $4, coalesce($5, now()), coalesce($6, 5))
       on conflict do nothing
       returning id::text`,
      [
        input.type,
        input.payload,
        input.traceId,
        input.dedupeKey ?? null,
        input.runAt ?? null,
        input.maxAttempts ?? null,
      ],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * FOR UPDATE SKIP LOCKED is what makes this safe with N workers: each
   * transaction takes rows nobody else has locked, so workers never
   * collide and never block one another.
   */
  async claim(workerId: string, limit: number): Promise<Job[]> {
    const { rows } = await pool.query<JobRow>(
      `update jobs j
          set status = 'running',
              attempts = j.attempts + 1,
              locked_at = now(),
              locked_by = $1,
              heartbeat_at = now(),
              updated_at = now()
        where j.id in (
          select id from jobs
           where status = 'pending' and run_at <= now()
           order by run_at, id
           for update skip locked
           limit $2
        )
        returning j.id::text, j.type, j.payload, j.attempts, j.max_attempts, j.trace_id`,
      [workerId, limit],
    );

    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      payload: r.payload,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      traceId: r.trace_id ?? "unknown",
    }));
  }

  async complete(id: string): Promise<void> {
    await pool.query(
      `update jobs set status='done', locked_by=null, heartbeat_at=null, updated_at=now() where id=$1`,
      [id],
    );
  }

  async retry(id: string, error: string, delayMs: number): Promise<void> {
    await pool.query(
      `update jobs
          set status='pending', run_at = now() + make_interval(secs => $2::float8),
              last_error=$3, locked_by=null, locked_at=null, heartbeat_at=null, updated_at=now()
        where id=$1`,
      [id, delayMs / 1000, error.slice(0, 2000)],
    );
  }

  async kill(id: string, error: string): Promise<void> {
    await pool.query(
      `update jobs set status='dead', last_error=$2, locked_by=null, heartbeat_at=null, updated_at=now()
        where id=$1`,
      [id, error.slice(0, 2000)],
    );
  }

  async heartbeat(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await pool.query(`update jobs set heartbeat_at=now() where id = any($1::bigint[])`, [ids]);
  }

  /**
   * Workers die mid-stage. Without this, those jobs sit in 'running'
   * forever and the document never finishes — the single most common way
   * a queue quietly stops working.
   */
  async reap(staleAfterMs: number): Promise<number> {
    const { rowCount } = await pool.query(
      `update jobs
          set status = case when attempts >= max_attempts then 'dead'::job_status else 'pending'::job_status end,
              last_error = coalesce(last_error, 'worker stopped heartbeating'),
              locked_by = null, heartbeat_at = null, updated_at = now()
        where status = 'running'
          and heartbeat_at < now() - make_interval(secs => $1::float8)`,
      [staleAfterMs / 1000],
    );
    return rowCount ?? 0;
  }

  async depth(): Promise<{ pending: number; running: number; dead: number }> {
    const { rows } = await pool.query<{ status: string; n: string }>(
      `select status::text, count(*)::text as n from jobs group by status`,
    );
    const by = new Map(rows.map((r) => [r.status, Number(r.n)]));
    return {
      pending: by.get("pending") ?? 0,
      running: by.get("running") ?? 0,
      dead: by.get("dead") ?? 0,
    };
  }
}

export const queue: Queue = new PgQueue();
