import { tx } from "@memwe/db";
import { DocumentJobPayload, MemweError } from "@memwe/contracts";
import type { Job } from "@memwe/contracts";
import type { StageContext } from "./index.js";

/**
 * Stage 01 — accept.
 *
 * Content-hash dedupe already happened at the API boundary (it has to,
 * so the caller gets the existing id back synchronously). What's left
 * here is admitting the document into the pipeline and handing off.
 */
export async function accept(job: Job, ctx: StageContext): Promise<void> {
  const p = DocumentJobPayload.parse(job.payload);

  await tx(async (c) => {
    const { rows } = await c.query<{ id: string; status: string; markdown: string | null }>(
      `select id::text, status::text, markdown from documents where id = $1 for update`,
      [p.documentId],
    );
    const doc = rows[0];
    if (!doc) throw new MemweError("not_found", `document ${p.documentId} vanished`);

    if (doc.status !== "queued") {
      ctx.log.info("already admitted, skipping", { documentId: doc.id, status: doc.status });
      return;
    }

    await c.query(`update documents set status='extracting', updated_at=now() where id=$1`, [
      doc.id,
    ]);
  });

  const { queue } = await import("../queue.js");
  await queue.enqueue({
    type: "document.extract",
    payload: { ...p },
    traceId: job.traceId,
    dedupeKey: `extract:${p.documentId}`,
  });

  ctx.log.info("accepted", { documentId: p.documentId });
}
