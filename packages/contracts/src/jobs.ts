import { z } from "zod";
import { ContainerTag } from "./tenant.js";

/**
 * ONE ENVELOPE FOR EVERY JOB.
 *
 * Retries, backoff, dead-lettering and tracing behave identically for
 * every job type because every job type carries the same outer shape.
 * Add a job by adding to JobType + a payload schema, never by inventing
 * a new envelope.
 */
export const JobEnvelope = z.object({
  orgId: z.guid(),
  container: ContainerTag,
  /** Threaded from the HTTP request through every stage. Log it always. */
  traceId: z.string(),
});
export type JobEnvelope = z.infer<typeof JobEnvelope>;

export const JobType = z.enum([
  "document.accept", // stage 01 — dedupe, hash, admit
  "document.extract", // stage 02 — bytes/URL -> NormalizedDoc
  "document.chunk", // stage 04
  "document.embed", // stage 06
  "document.index", // stage 06
  "memory.distill", // stage 07  (Sprint 3)
  "memory.reconcile", // stage 08  (Sprint 3)
  "session.promote", // working -> episodic (Sprint 4)
  "graph.consolidate", // nightly (Sprint 4)
  "connector.sync", // (Sprint 6)
]);
export type JobType = z.infer<typeof JobType>;

export const DocumentJobPayload = JobEnvelope.extend({
  documentId: z.guid(),
});
export type DocumentJobPayload = z.infer<typeof DocumentJobPayload>;

export const SessionJobPayload = JobEnvelope.extend({
  sessionId: z.guid(),
});
export type SessionJobPayload = z.infer<typeof SessionJobPayload>;

/** Payload schema per job type. The runner validates before dispatching. */
export const JOB_PAYLOAD: Record<JobType, z.ZodTypeAny> = {
  "document.accept": DocumentJobPayload,
  "document.extract": DocumentJobPayload,
  "document.chunk": DocumentJobPayload,
  "document.embed": DocumentJobPayload,
  "document.index": DocumentJobPayload,
  "memory.distill": DocumentJobPayload,
  "memory.reconcile": DocumentJobPayload,
  "session.promote": SessionJobPayload,
  "graph.consolidate": JobEnvelope,
  "connector.sync": JobEnvelope.extend({ connectionId: z.guid() }),
};

export type Job<P = unknown> = {
  id: string;
  type: JobType;
  payload: P;
  attempts: number;
  maxAttempts: number;
  traceId: string;
};
