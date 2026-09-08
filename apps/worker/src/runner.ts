import { randomUUID } from "node:crypto";
import type { Job } from "@memwe/contracts";
import { DocumentJobPayload, isRetryable, JOB_PAYLOAD, MemweError } from "@memwe/contracts";
import { log } from "./log.js";
import { queue } from "./queue.js";
import { documentTx, StaleJobError } from "./stages/guard.js";
import { STAGES } from "./stages/index.js";
import { nextStage } from "./stages/pipeline.js";
import { advanceStatus, failDocument, STAGE_STATUS, STATUS_ORDER } from "./status.js";

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 4);
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 500);
const HEARTBEAT_MS = Number(process.env.WORKER_HEARTBEAT_MS ?? 5000);
const STALE_MS = HEARTBEAT_MS * 6;

/** Exponential with jitter, capped at 5 minutes. */
function backoffMs(attempts: number): number {
  const base = Math.min(2 ** attempts * 1000, 300_000);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export class Runner {
  private readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly inflight = new Map<string, Job>();
  private stopping = false;
  private timers: NodeJS.Timeout[] = [];

  async start(): Promise<void> {
    log.info("worker up", { workerId: this.workerId, concurrency: CONCURRENCY });

    this.timers.push(
      setInterval(() => {
        void queue.heartbeat([...this.inflight.values()]).catch((e: unknown) => {
          log.error("heartbeat failed", { err: String(e) });
        });
      }, HEARTBEAT_MS),
    );

    this.timers.push(
      setInterval(() => {
        void queue
          .reap(STALE_MS)
          .then((n) => {
            if (n > 0) log.warn("reaped stale jobs", { count: n });
          })
          .catch((err) => log.error("reaper failed", { err: String(err) }));
      }, STALE_MS),
    );

    while (!this.stopping) {
      const slots = CONCURRENCY - this.inflight.size;
      if (slots <= 0) {
        await sleep(POLL_MS);
        continue;
      }

      let jobs: Job[] = [];
      try {
        jobs = await queue.claim(this.workerId, slots);
      } catch (err) {
        log.error("claim failed", { err: String(err) });
        await sleep(POLL_MS * 4);
        continue;
      }

      if (jobs.length === 0) {
        await sleep(POLL_MS);
        continue;
      }

      for (const job of jobs) {
        this.inflight.set(job.id, job);
        void this.run(job)
          .catch((err) => log.error("job recovery failed", { err: String(err) }))
          .finally(() => this.inflight.delete(job.id));
      }
    }
  }

  /** Public for integration tests that exercise the same dispatch path as the poller. */
  async run(job: Job): Promise<void> {
    const jlog = log.child({ jobId: job.id, type: job.type, traceId: job.traceId });
    const started = Date.now();
    try {
      const stage = STAGES[job.type];
      if (!stage) throw new MemweError("invalid_request", `no stage registered for ${job.type}`);
      job.payload = JOB_PAYLOAD[job.type].parse(job.payload);
      const parsed = DocumentJobPayload.safeParse(job.payload);
      if (parsed.success) {
        const p = parsed.data;
        await documentTx(job, async (c) => {
          const status = STAGE_STATUS[job.type];
          if (!status) return;
          const r = await c.query<{ status: typeof status }>(
            "select status from documents where id=$1",
            [p.documentId],
          );
          if (STATUS_ORDER.indexOf(r.rows[0]!.status) > STATUS_ORDER.indexOf(status)) {
            throw new StaleJobError("stage already passed");
          }
          await advanceStatus(c, p.documentId, status);
        });
      }
      const result = await stage(job, { log: jlog });
      if (parsed.success) {
        const p = parsed.data;
        await documentTx(job, async (c) => {
          if (result && "deferMs" in result) {
            await c.query(
              `update jobs set status='pending',max_attempts=max_attempts+1,
              run_at=now()+make_interval(secs=>$2::float8),locked_by=null,heartbeat_at=null
              where id=$1`,
              [job.id, result.deferMs / 1000],
            );
            return;
          }
          if (!(await queue.complete(job, c))) throw new StaleJobError("lease lost before handoff");
          const next = nextStage(job.type);
          if (result && "halt" in result) {
            await advanceStatus(c, p.documentId, "done");
          } else if (next) {
            await queue.enqueue(
              {
                type: next,
                payload: p,
                traceId: job.traceId,
                dedupeKey: `${next}:${p.documentId}:${p.revision}`,
              },
              c,
            );
          } else {
            await advanceStatus(c, p.documentId, "done");
          }
        });
      } else {
        await queue.complete(job);
      }
      jlog.info("job done", { ms: Date.now() - started });
    } catch (err) {
      if (err instanceof StaleJobError) {
        await queue.complete(job);
        jlog.info("obsolete job skipped", { reason: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (isRetryable(err) && job.attempts < job.maxAttempts) {
        await queue.retry(job, message, backoffMs(job.attempts));
        jlog.warn("job failed, retrying", { err: message, attempt: job.attempts });
      } else {
        const parsed = DocumentJobPayload.safeParse(job.payload);
        if (parsed.success) {
          try {
            await documentTx(job, async (c) => {
              if (await queue.kill(job, message, c)) {
                await failDocument(c, parsed.data.documentId, job.type, message);
              }
            });
          } catch (failure) {
            if (!(failure instanceof StaleJobError)) throw failure;
            await queue.kill(job, message);
          }
        } else {
          await queue.kill(job, message);
        }
        jlog.error("job dead", { err: message });
      }
    }
  }

  /** Stop taking new work, let in-flight jobs finish, then release. */
  async stop(graceMs = 15_000): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    log.info("draining", { inflight: this.inflight.size });

    for (const t of this.timers) clearInterval(t);
    this.timers = [];

    const deadline = Date.now() + graceMs;
    while (this.inflight.size > 0 && Date.now() < deadline) await sleep(200);

    if (this.inflight.size > 0) {
      log.warn("grace expired, abandoning jobs to the reaper", { count: this.inflight.size });
    }
    log.info("worker down");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
