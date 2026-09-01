import type { Job } from "@memwe/contracts";
import { DocumentJobPayload, MemweError } from "@memwe/contracts";
import { tx } from "@memwe/db";
import { EMBED_DIM, embedAll, provider } from "../embed/index.js";
import { queue } from "../queue.js";
import type { StageContext } from "./index.js";
import { nextStage } from "./pipeline.js";

type ChunkRow = { id: string; text: string; context_header: string | null };

/** Written batch by batch, so a failure halfway leaves real work banked. */
const WRITE_BATCH = Number(process.env["EMBED_WRITE_BATCH"] ?? 200);

/**
 * Stage 06 — embed.
 *
 * Only touches chunks whose vector is missing or was produced by a model we
 * are no longer using. That makes the stage idempotent, makes a model
 * change a matter of re-running it, and makes a partial failure resumable
 * rather than a reason to start over.
 */
export async function embedStage(job: Job, ctx: StageContext): Promise<void> {
  const p = DocumentJobPayload.parse(job.payload);
  const model = provider(ctx.log).id;

  const pending = await tx(async (c) => {
    const r = await c.query<ChunkRow>(
      `select id::text, text, context_header
         from chunks
        where document_id = $1 and container = $2
          and (embedding is null or embed_model is distinct from $3)
        order by ord`,
      [p.documentId, p.container, model],
    );
    return r.rows;
  });

  if (pending.length === 0) {
    ctx.log.debug("nothing to embed", { documentId: p.documentId, model });
  } else {
    // The context header is prepended for embedding but not stored inside
    // `text` — the chunk's own words stay retrievable verbatim, while the
    // vector knows which section it came from.
    const texts = pending.map((c) =>
      c.context_header ? `${c.context_header}\n\n${c.text}` : c.text,
    );

    const started = Date.now();
    const { vectors, batches, dims } = await embedAll(texts, ctx.log, "document");
    if (vectors.length !== pending.length) {
      throw new MemweError(
        "upstream_failed",
        `embedded ${vectors.length} vectors for ${pending.length} chunks`,
      );
    }

    for (let i = 0; i < pending.length; i += WRITE_BATCH) {
      const slice = pending.slice(i, i + WRITE_BATCH);
      const vecs = vectors.slice(i, i + WRITE_BATCH);
      await tx(async (c) => {
        await c.query(
          `update chunks as k
              set embedding   = v.embedding::vector,
                  embed_model = $2,
                  embed_dim   = $3,
                  embedded_at = now()
             from (select (e->>'id')::bigint as id, e->>'embedding' as embedding
                     from jsonb_array_elements($4::jsonb) as e) as v
            where k.id = v.id and k.container = $1`,
          [
            p.container,
            model,
            dims,
            JSON.stringify(
              slice.map((row, n) => ({ id: row.id, embedding: JSON.stringify(vecs[n]) })),
            ),
          ],
        );
      });
    }

    ctx.log.info("embedded", {
      documentId: p.documentId,
      chunks: pending.length,
      batches,
      model,
      dims,
      ms: Date.now() - started,
    });
  }

  const next = nextStage("document.embed");
  if (next) {
    await queue.enqueue({
      type: next,
      payload: { ...p },
      traceId: job.traceId,
      dedupeKey: `${next}:${p.documentId}`,
    });
    return;
  }

  await tx(async (c) => {
    await c.query(`update documents set status = 'done', updated_at = now() where id = $1`, [
      p.documentId,
    ]);
  });
}

export { EMBED_DIM };
