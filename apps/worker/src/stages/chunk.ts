import { createHash } from "node:crypto";
import { DocumentJobPayload, type Job, MemweError, type Section } from "@memwe/contracts";
import { chunkDocument, contextHeader } from "../chunk/index.js";
import { contextProvider } from "../context/index.js";
import { documentTx } from "./guard.js";
import type { StageContext } from "./index.js";

/** What gets embedded: generated context, then heading path, then the text. */
export const embeddingInput = (
  text: string,
  header: string | null,
  context: string | null = null,
): string => {
  const preface = [context, header].filter((s): s is string => Boolean(s)).join("\n");
  return preface ? `${preface}\n\n${text}` : text;
};
export const inputHash = (text: string, header: string | null, context: string | null = null) =>
  createHash("sha256")
    .update(embeddingInput(text, header, context))
    .digest("hex");

export async function chunkStage(job: Job, ctx: StageContext): Promise<undefined> {
  const p = DocumentJobPayload.parse(job.payload);
  await documentTx(job, async (c) => {
    const row = (
      await c.query<{
        markdown: string | null;
        title: string | null;
        metadata: { sections?: Section[] };
      }>(`select markdown,title,metadata from documents where id=$1`, [p.documentId])
    ).rows[0]!;
    if (!row.markdown?.trim()) throw new MemweError("unsupported_content", "nothing to chunk");
    const doc = { markdown: row.markdown, title: row.title, sections: row.metadata.sections ?? [] };
    const chunks = chunkDocument(doc, ctx.log);
    // A generated context survives a revision only when the chunk text, its
    // heading path and the model are all unchanged — that is the whole input
    // it was written from, minus the rest of the document. Anything else is
    // regenerated, which is what keeps embedding reuse honest.
    const writer = contextProvider();
    const carried = new Map<string, string>();
    if (writer) {
      const prior = await c.query<{ key: string; generated_context: string }>(
        `select encode(text_hash,'hex')||E'\n'||coalesce(context_header,'') as key,generated_context
           from chunks where document_id=$1 and container=$2
            and generated_context is not null and context_model=$3`,
        [p.documentId, p.container, writer.id],
      );
      for (const r of prior.rows) carried.set(r.key, r.generated_context);
    }
    const rows = chunks.map((k) => {
      const header = contextHeader(doc, k);
      const textHash = createHash("sha256").update(k.text).digest("hex");
      const context = carried.get(`${textHash}\n${header ?? ""}`) ?? null;
      return {
        ord: k.ord,
        text: k.text,
        context_header: header,
        generated_context: context,
        context_model: context && writer ? writer.id : null,
        span_start: k.spanStart,
        span_end: k.spanEnd,
        token_count: k.tokenCount,
        source_ranges: k.sourceRanges,
        text_hash: textHash,
        embedding_input_hash: inputHash(k.text, header, context),
      };
    });
    // Cache entries include the exact full input and their model stamp. The embed
    // stage replaces entries from a different model. Reuse is tenant/container-local.
    await c.query(
      `with old as materialized (
      select distinct on (embedding_input_hash) embedding_input_hash,embedding,embed_model,embed_dim,embedded_at
      from chunks where org_id=$3 and container=$2 and embedding is not null and embedding_input_hash is not null
      order by embedding_input_hash,embedded_at desc
    ), del as (delete from chunks where document_id=$1 and container=$2)
    insert into chunks (document_id,org_id,container,revision,ord,text,context_header,generated_context,context_model,
      span_start,span_end,token_count,source_ranges,text_hash,embedding_input_hash,embedding,embed_model,embed_dim,embedded_at)
    select $1,$3,$2,$5,(v->>'ord')::int,v->>'text',v->>'context_header',v->>'generated_context',v->>'context_model',
      (v->>'span_start')::int,(v->>'span_end')::int,(v->>'token_count')::int,v->'source_ranges',decode(v->>'text_hash','hex'),
      decode(v->>'embedding_input_hash','hex'),o.embedding,o.embed_model,o.embed_dim,o.embedded_at
    from jsonb_array_elements($4::jsonb) v left join old o on o.embedding_input_hash=decode(v->>'embedding_input_hash','hex')`,
      [p.documentId, p.container, p.orgId, JSON.stringify(rows), p.revision],
    );
    ctx.log.info("chunked", {
      documentId: p.documentId,
      chunks: chunks.length,
      contextCarried: rows.filter((r) => r.generated_context).length,
      maxTokens: Math.max(...chunks.map((k) => k.tokenCount)),
    });
  });
}
