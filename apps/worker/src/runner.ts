import { randomUUID } from "node:crypto";
import type { Job } from "@memwe/contracts";
import { isRetryable, JOB_PAYLOAD, MemweError } from "@memwe/contracts";
import { tx } from "@memwe/db";
import { log } from "./log.js";
import { queue } from "./queue.js";
import { STAGES } from "./stages/index.js";
import { nextStage } from "./stages/pipeline.js";
import { advanceStatus, failDocument, STAGE_STATUS } from "./status.js";

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
      const documentId = this.documentIdOf(job);

      // The runner owns the status machine, not the stages. Each stage
      // writing its own status is how three of the seven declared states
      // stayed unused while documents reported `extracting` for the whole
      // run. Set at dispatch, so the status is what is actually running.
      const status = STAGE_STATUS[job.type];
      if (documentId && status) {
        await tx((c) => advanceStatus(c, documentId, status));
      }

      const result = await stage(job, { log: jlog });
      await queue.complete(job.id);

      // Advancement is the runner's too, so a stage never has to know what
      // follows it and three stages stop repeating the same block.
      if (result && "halt" in result) {
        jlog.info("pipeline halted", { reason: result.reason });
      } else if (documentId) {
        await this.advance(job, documentId, jlog);
      }

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
        // A dead job on a document must fail the document too. Otherwise it
        // sits mid-pipeline forever, invisible to anyone looking at the API
        // and indistinguishable from work still in progress.
        await this.failDocument(job, message, jlog);
        jlog.error("job dead", { err: message, attempts: job.attempts, exhausted });
      }
    }
  }

  private documentIdOf(job: Job): string | null {
    const payload = job.payload as { documentId?: unknown };
    return typeof payload?.documentId === "string" ? payload.documentId : null;
  }

  private async advance(job: Job, documentId: string, jlog: typeof log): Promise<void> {
    const next = nextStage(job.type);
    if (next) {
      await queue.enqueue({
        type: next,
        payload: job.payload as Record<string, unknown>,
        traceId: job.traceId,
        dedupeKey: `${next}:${documentId}`,
      });
      return;
    }
    // Nothing further is registered, so the pipeline is complete for this
    // document as currently built.
    const moved = await tx((c) => advanceStatus(c, documentId, "done"));
    if (moved) jlog.debug("pipeline complete", { documentId });
  }

  private async failDocument(job: Job, error: string, jlog: typeof log): Promise<void> {
    const documentId = this.documentIdOf(job);
    if (!documentId) return;
    try {
      await tx((c) => failDocument(c, documentId, job.type, error));
    } catch (err) {
      jlog.error("could not mark document failed", { err: String(err) });
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
