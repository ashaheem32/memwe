import { randomUUID } from "node:crypto";
import type { Job } from "@memwe/contracts";
import { isRetryable, JOB_PAYLOAD, MemweError } from "@memwe/contracts";
import { log } from "./log.js";
import { queue } from "./queue.js";
import { STAGES } from "./stages/index.js";

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
        void queue.heartbeat([...this.inflight.keys()]).catch((e: unknown) => {
          log.error("heartbeat failed", { err: String(e) });
        });
      }, HEARTBEAT_MS),
    );

    this.timers.push(
      setInterval(() => {
        void queue.reap(STALE_MS).then((n) => {
          if (n > 0) log.warn("reaped stale jobs", { count: n });
        });
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
        void this.run(job).finally(() => this.inflight.delete(job.id));
      }
    }
  }

  private async run(job: Job): Promise<void> {
    const jlog = log.child({ jobId: job.id, type: job.type, traceId: job.traceId });
    const started = Date.now();

    try {
      const stage = STAGES[job.type];
      if (!stage) {
        // Unregistered type: never retry. Retrying a job nothing can
        // handle just burns five attempts and hides the real problem.
        throw new MemweError("invalid_request", `no stage registered for ${job.type}`);
      }

      const schema = JOB_PAYLOAD[job.type];
      job.payload = schema.parse(job.payload) as unknown;

      await stage(job, { log: jlog });
      await queue.complete(job.id);
      jlog.info("job done", { ms: Date.now() - started });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const exhausted = job.attempts >= job.maxAttempts;
      const retry = isRetryable(err) && !exhausted;

      if (retry) {
        const delay = backoffMs(job.attempts);
        await queue.retry(job.id, message, delay);
        jlog.warn("job failed, retrying", {
          err: message,
          attempt: job.attempts,
          retryInMs: delay,
        });
      } else {
        await queue.kill(job.id, message);
        jlog.error("job dead", { err: message, attempts: job.attempts, exhausted });
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
