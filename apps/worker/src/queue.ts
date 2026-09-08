import type { Job, JobType } from "@memwe/contracts";
import { lockIngestion, type PoolClient, pool, tx } from "@memwe/db";

/**
 * The queue interface. Everything the runner uses lives here, so
 * swapping the Postgres implementation for pgmq or SQS later is one
 * file and no call-site changes.
 */
export interface Queue {
  enqueue(input: EnqueueInput, client?: PoolClient): Promise<string | null>;
  claim(workerId: string, limit: number): Promise<Job[]>;
  complete(job: Job, client?: PoolClient): Promise<boolean>;
  retry(job: Job, error: string, delayMs: number): Promise<void>;
  kill(job: Job, error: string, client?: PoolClient): Promise<boolean>;
  heartbeat(jobs: Job[]): Promise<void>;
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
  async enqueue(input: EnqueueInput, client?: PoolClient): Promise<string | null> {
    const { rows } = await (client ?? pool).query<{ id: string }>(
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
      lockedBy: workerId,
    }));
  }

  async complete(job: Job, client?: PoolClient): Promise<boolean> {
    const r = await (client ?? pool).query(
      `update jobs set status='done', locked_by=null, heartbeat_at=null, updated_at=now()
       where id=$1 and status='running' and locked_by=$2 and attempts=$3`,
      [job.id, job.lockedBy, job.attempts],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async retry(job: Job, error: string, delayMs: number): Promise<void> {
    await pool.query(
      `update jobs set status='pending', run_at=now()+make_interval(secs=>$4::float8),
         last_error=$5, locked_by=null, locked_at=null, heartbeat_at=null, updated_at=now()
       where id=$1 and status='running' and locked_by=$2 and attempts=$3`,
      [job.id, job.lockedBy, job.attempts, delayMs / 1000, error.slice(0, 2000)],
    );
  }

  async kill(job: Job, error: string, client?: PoolClient): Promise<boolean> {
    const r = await (client ?? pool).query(
      `update jobs set status='dead', last_error=$4, locked_by=null, heartbeat_at=null, updated_at=now()
       where id=$1 and status='running' and locked_by=$2 and attempts=$3`,
      [job.id, job.lockedBy, job.attempts, error.slice(0, 2000)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async heartbeat(jobs: Job[]): Promise<void> {
    if (jobs.length === 0) return;
    await pool.query(
      `update jobs j set heartbeat_at=now()
       from jsonb_to_recordset($1::jsonb) as v(id bigint, owner text, attempt int)
       where j.id=v.id and j.locked_by=v.owner and j.attempts=v.attempt and j.status='running'`,
      [JSON.stringify(jobs.map((j) => ({ id: j.id, owner: j.lockedBy, attempt: j.attempts })))],
    );
  }

  async reap(staleAfterMs: number): Promise<number> {
    const candidates = await pool.query<{ id: string; payload: Record<string, unknown> }>(
      `select id::text, payload from jobs where status='running'
       and heartbeat_at < now()-make_interval(secs=>$1::float8)`,
      [staleAfterMs / 1000],
    );
    let count = 0;
    for (const candidate of candidates.rows) {
      count += await tx(async (c) => {
        const p = candidate.payload;
        if (typeof p.orgId === "string" && typeof p.container === "string") {
          await lockIngestion(c, p.orgId, p.container);
        }
        const r = await c.query<{ status: string; type: string }>(
          `update jobs set status=case when attempts>=max_attempts then 'dead'::job_status else 'pending'::job_status end,
           last_error='worker stopped heartbeating', locked_by=null, heartbeat_at=null, updated_at=now()
           where id=$1 and status='running' and heartbeat_at < now()-make_interval(secs=>$2::float8)
           returning status::text, type`,
          [candidate.id, staleAfterMs / 1000],
        );
        if (r.rows[0]?.status === "dead" && typeof p.documentId === "string") {
          await c.query(
            `update documents set status='failed', failed_stage=$4,
            stage_error='worker stopped heartbeating; attempts exhausted', status_changed_at=now(), updated_at=now()
            where id::text=$1 and org_id::text=$2 and container=$3 and revision=$5 and status not in ('done','failed')`,
            [p.documentId, p.orgId, p.container, r.rows[0].type, p.revision ?? 1],
          );
        }
        return r.rowCount ?? 0;
      });
    }
    return count;
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
