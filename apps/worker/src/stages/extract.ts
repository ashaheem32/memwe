import type { Job } from "@memwe/contracts";
import { DocumentJobPayload } from "@memwe/contracts";
import { tx } from "@memwe/db";
import type { StageContext } from "./index.js";

/**
 * Stage 02 — extract.  *** SPRINT 0 STUB ***
 *
 * Deliberately does nothing but advance the state machine. Building real
 * extraction now is the trap: a no-op stage that proves the pipeline is
 * worth more in week 1 than a working PDF parser hanging off a runner
 * that loses jobs.
 *
 * Sprint 1 replaces this with: fetch blob or URL, sniff the real MIME
 * (never trust the client's), route to an extractor, and emit a
 * NormalizedDoc *including the span map*.
 */
export async function extract(job: Job, ctx: StageContext): Promise<void> {
  const p = DocumentJobPayload.parse(job.payload);

  await tx(async (c) => {
    await c.query(
      `update documents
          set status = 'done',
              token_count = coalesce(token_count, ceil(length(coalesce(markdown,'')) / 4.0)::int),
              updated_at = now()
        where id = $1`,
      [p.documentId],
    );
  });

  ctx.log.info("extracted (stub)", { documentId: p.documentId });
}
