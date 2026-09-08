import { DocumentJobPayload, type Job, MemweError } from "@memwe/contracts";
import { EMBED_DIM, embedBatch, planBatches, provider } from "../embed/index.js";
import { embeddingInput } from "./chunk.js";
import { documentTx } from "./guard.js";
import type { StageContext } from "./index.js";

export async function embedStage(job: Job, ctx: StageContext): Promise<undefined> {
  const p = DocumentJobPayload.parse(job.payload),
    model = provider(ctx.log);
  const writeBatch = Number(process.env.EMBED_WRITE_BATCH ?? 200);
  if (!Number.isInteger(writeBatch) || writeBatch <= 0)
    throw new MemweError("invalid_request", "EMBED_WRITE_BATCH must be positive");
  const pending = await documentTx(
    job,
    async (c) =>
      (
        await c.query<{
          id: string;
          text: string;
          context_header: string | null;
          generated_context: string | null;
        }>(
          `select id::text,text,context_header,generated_context from chunks where document_id=$1 and container=$2 and revision=$3
     and (embedding is null or embed_model is distinct from $4 or embed_dim is distinct from $5) order by ord`,
          [p.documentId, p.container, p.revision, model.id, model.dimensions],
        )
      ).rows,
  );
  const batches = planBatches(
    pending.map((k) => ({
      text: embeddingInput(k.text, k.context_header, k.generated_context),
      kind: "document" as const,
    })),
    model,
  );
  let offset = 0;
  for (const batch of batches) {
    // Check before spending, then fence the write again after the external call.
    await documentTx(job, async () => {});
    const vectors = await embedBatch(model, batch, ctx.log);
    for (let i = 0; i < batch.length; i += writeBatch) {
      const rows = pending.slice(offset + i, offset + Math.min(batch.length, i + writeBatch));
      await documentTx(job, async (c) => {
        await c.query(
          `update chunks k set embedding=v.embedding::vector,embed_model=$4,embed_dim=$5,embedded_at=now()
          from jsonb_to_recordset($6::jsonb) as v(id bigint,embedding text)
          where k.id=v.id and k.document_id=$1 and k.container=$2 and k.revision=$3`,
          [
            p.documentId,
            p.container,
            p.revision,
            model.id,
            model.dimensions,
            JSON.stringify(
              rows.map((r, n) => ({ id: r.id, embedding: JSON.stringify(vectors[i + n]) })),
            ),
          ],
        );
      });
    }
    offset += batch.length;
  }
  ctx.log.info("embedded", {
    documentId: p.documentId,
    chunks: pending.length,
    batches: batches.length,
    model: model.id,
  });
}
export { EMBED_DIM };
