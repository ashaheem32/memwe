import { DocumentJobPayload, type Job, MemweError } from "@memwe/contracts";
import { tokens } from "../chunk/tokens.js";
import {
  type ContextUsage,
  contextConfig,
  contextProvider,
  type PassResult,
} from "../context/index.js";
import { inputHash } from "./chunk.js";
import { documentTx } from "./guard.js";
import type { StageContext } from "./index.js";

type Pending = { ord: number; text: string; context_header: string | null };

/**
 * Stage 05. Write a model-generated context for every chunk of the current
 * revision that does not already carry one from the configured model.
 *
 * Contexts carried across a revision by the chunk stage are not pending, so
 * a small edit only sends the changed chunks. Each pass is persisted before
 * the next request, so a retry after a mid-document failure resumes with
 * only the missing chunks — and never re-bills the ones already written.
 */
export async function contextualizeStage(job: Job, ctx: StageContext): Promise<undefined> {
  const p = DocumentJobPayload.parse(job.payload);
  const writer = contextProvider(ctx.log);
  if (!writer) return;
  const cfg = contextConfig();

  const { doc, pending, total } = await documentTx(job, async (c) => {
    const row = (
      await c.query<{ markdown: string | null; title: string | null }>(
        "select markdown,title from documents where id=$1",
        [p.documentId],
      )
    ).rows[0];
    if (!row?.markdown?.trim())
      throw new MemweError("unsupported_content", "nothing to contextualize");
    const chunks = await c.query<Pending>(
      `select ord,text,context_header from chunks
       where document_id=$1 and container=$2 and revision=$3
         and (generated_context is null or context_model is distinct from $4)
       order by ord`,
      [p.documentId, p.container, p.revision, writer.id],
    );
    const all = await c.query<{ n: number }>(
      "select count(*)::int n from chunks where document_id=$1 and container=$2 and revision=$3",
      [p.documentId, p.container, p.revision],
    );
    return {
      doc: { markdown: row.markdown, title: row.title },
      pending: chunks.rows,
      total: all.rows[0]?.n ?? 0,
    };
  });
  const reused = total - pending.length;
  if (pending.length === 0) {
    ctx.log.info("context reused", { documentId: p.documentId, chunks: total, model: writer.id });
    return;
  }

  const docTokens = tokens.count(doc.markdown);
  if (docTokens > cfg.maxDocTokens) {
    // Recorded on the document, not just logged: a corpus with silent gaps
    // in its context is the kind of degradation nothing downstream notices.
    ctx.log.warn("document too large for context generation — heading path only", {
      documentId: p.documentId,
      tokens: docTokens,
      limit: cfg.maxDocTokens,
    });
    await record(job, {
      model: writer.id,
      chunks: total,
      skipped: "document exceeds CONTEXT_MAX_DOC_TOKENS",
      tokens: docTokens,
    });
    return;
  }

  const byOrd = new Map(pending.map((k) => [k.ord, k]));
  const usage: ContextUsage = {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  };
  let passes = 0,
    generated = 0,
    missing = 0,
    refused = 0;
  const models = new Set<string>();

  await writer.write(
    doc,
    pending.map((k) => ({ ord: k.ord, text: k.text, path: k.context_header })),
    {
      // Check before spending, then fence the write again after the external call.
      beforePass: async () => {
        await documentTx(job, async () => {});
      },
      afterPass: async (pass: PassResult) => {
        passes++;
        missing += pass.missing.length;
        if (pass.refused) refused += pass.missing.length;
        for (const k of Object.keys(usage) as (keyof ContextUsage)[]) usage[k] += pass.usage[k];
        if (pass.contexts.size === 0) return;
        models.add(pass.model);
        generated += pass.contexts.size;
        await persist(job, pass, byOrd, writer.id);
      },
    },
    ctx.log,
  );

  await record(job, {
    model: writer.id,
    // The fallback chain can serve a pass on another model; that is recorded
    // here, while the chunk rows keep the configured identity so a retry
    // does not treat them as missing and bill them again.
    servedBy: [...models],
    chunks: total,
    reused,
    generated,
    missing,
    refused,
    passes,
    usage,
  });
  ctx.log.info("contextualized", {
    documentId: p.documentId,
    chunks: total,
    reused,
    generated,
    missing,
    passes,
    model: writer.id,
    ...usage,
  });
}

/**
 * Store one pass. The embedding input now starts with the context, so its
 * hash moves — and with it any vector the chunk stage copied over. A vector
 * for the new input is reused when one exists in the container; otherwise
 * the embed stage computes it.
 */
async function persist(
  job: Job,
  pass: PassResult,
  byOrd: Map<number, Pending>,
  modelId: string,
): Promise<void> {
  const p = DocumentJobPayload.parse(job.payload);
  const rows = [...pass.contexts].flatMap(([ord, context]) => {
    const k = byOrd.get(ord);
    return k ? [{ ord, context, hash: inputHash(k.text, k.context_header, context) }] : [];
  });
  await documentTx(job, async (c) => {
    await c.query(
      `update chunks k
          set generated_context=v.context, context_model=$5,
              embedding_input_hash=decode(v.hash,'hex'),
              embedding=o.embedding, embed_model=o.embed_model, embed_dim=o.embed_dim, embedded_at=o.embedded_at
         from jsonb_to_recordset($4::jsonb) as v(ord int, context text, hash text)
         left join lateral (
           select embedding,embed_model,embed_dim,embedded_at from chunks o
            where o.org_id=$3 and o.container=$2 and o.embedding is not null
              and o.embedding_input_hash=decode(v.hash,'hex')
            order by o.embedded_at desc limit 1) o on true
        where k.document_id=$1 and k.container=$2 and k.revision=$6 and k.ord=v.ord`,
      [p.documentId, p.container, p.orgId, JSON.stringify(rows), modelId, p.revision],
    );
  });
}

/** What context generation did and cost, on the document where a reader can find it. */
async function record(job: Job, summary: Record<string, unknown>): Promise<void> {
  const p = DocumentJobPayload.parse(job.payload);
  await documentTx(job, async (c) => {
    await c.query(
      `update documents set metadata=metadata||jsonb_build_object('context',$2::jsonb),updated_at=now()
        where id=$1`,
      [p.documentId, JSON.stringify(summary)],
    );
  });
}
