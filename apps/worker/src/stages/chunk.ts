import { createHash } from "node:crypto";
import { DocumentJobPayload, type Job, MemweError, type Section } from "@memwe/contracts";
import { chunkDocument, contextHeader } from "../chunk/index.js";
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

/** What a revision changed at chunk level. Recorded on the document as `metadata.diff`. */
export type RevisionDiff = {
  from: number | null;
  to: number;
  kept: number;
  added: number;
  removed: number;
  moved: number;
};

type Current = {
  id: string;
  ord: number;
  revision: number;
  key: string;
};

/**
 * Stage 04. Chunk the current markdown and reconcile the rows with what
 * the previous revision left behind.
 *
 * A revision does not rebuild everything. A chunk whose text and heading
 * path are unchanged keeps its row — its id, its generated context, its
 * vector — and only moves to the new revision and position. Chunks that
 * changed or appeared are inserted; chunks that disappeared are deleted.
 * Downstream stages see only the new rows as pending, so a one-paragraph
 * edit costs one paragraph of model calls, and anything that cited a
 * chunk of the old revision still points at the same row.
 */
export async function chunkStage(job: Job, ctx: StageContext): Promise<undefined> {
  const p = DocumentJobPayload.parse(job.payload);
  await documentTx(job, async (c) => {
    const row = (
      await c.query<{
        markdown: string | null;
        title: string | null;
        metadata: { sections?: Section[] };
      }>("select markdown,title,metadata from documents where id=$1", [p.documentId])
    ).rows[0]!;
    if (!row.markdown?.trim()) throw new MemweError("unsupported_content", "nothing to chunk");
    const doc = { markdown: row.markdown, title: row.title, sections: row.metadata.sections ?? [] };
    const chunks = chunkDocument(doc, ctx.log);

    // The identity of a chunk across revisions is its text plus its heading
    // path — the whole input its context and vector were made from, minus
    // the rest of the document. Same key, same row.
    const current = (
      await c.query<Current>(
        `select id::text,ord,revision,encode(text_hash,'hex')||E'\n'||coalesce(context_header,'') as key
           from chunks where document_id=$1 and container=$2 order by ord`,
        [p.documentId, p.container],
      )
    ).rows;
    const previous = current.reduce<number | null>(
      (max, r) => (max === null || r.revision > max ? r.revision : max),
      null,
    );
    const available = new Map<string, Current[]>();
    for (const r of current) available.set(r.key, [...(available.get(r.key) ?? []), r]);

    const kept: Array<{ id: string; prevOrd: number; ord: number; row: Positional }> = [];
    const added: Array<Positional & NewRow> = [];
    for (const k of chunks) {
      const header = contextHeader(doc, k);
      const textHash = createHash("sha256").update(k.text).digest("hex");
      const positional: Positional = {
        ord: k.ord,
        span_start: k.spanStart,
        span_end: k.spanEnd,
        token_count: k.tokenCount,
        source_ranges: k.sourceRanges,
      };
      const match = available.get(`${textHash}\n${header ?? ""}`)?.shift();
      if (match) {
        kept.push({ id: match.id, prevOrd: match.ord, ord: k.ord, row: positional });
        continue;
      }
      added.push({
        ...positional,
        text: k.text,
        context_header: header,
        text_hash: textHash,
        embedding_input_hash: inputHash(k.text, header),
      });
    }
    const removed = [...available.values()].flat().map((r) => r.id);

    if (removed.length > 0)
      await c.query(
        "delete from chunks where document_id=$1 and container=$2 and id=any($3::bigint[])",
        [p.documentId, p.container, removed],
      );
    if (kept.length > 0)
      await c.query(
        `update chunks k set revision=$3,ord=v.ord,span_start=v.span_start,span_end=v.span_end,
                token_count=v.token_count,source_ranges=v.source_ranges
           from jsonb_to_recordset($4::jsonb)
             as v(id bigint,ord int,span_start int,span_end int,token_count int,source_ranges jsonb)
          where k.id=v.id and k.document_id=$1 and k.container=$2`,
        [
          p.documentId,
          p.container,
          p.revision,
          JSON.stringify(kept.map((x) => ({ id: x.id, ...x.row }))),
        ],
      );
    // A new row reuses a vector when the container already holds one for the
    // exact same input. Entries carry their model stamp; the embed stage
    // replaces those from a different model.
    if (added.length > 0)
      await c.query(
        `with old as materialized (
          select distinct on (embedding_input_hash) embedding_input_hash,embedding,embed_model,embed_dim,embedded_at
            from chunks where org_id=$3 and container=$2 and embedding is not null and embedding_input_hash is not null
           order by embedding_input_hash,embedded_at desc)
        insert into chunks (document_id,org_id,container,revision,ord,text,context_header,span_start,span_end,token_count,
          source_ranges,text_hash,embedding_input_hash,embedding,embed_model,embed_dim,embedded_at)
        select $1,$3,$2,$5,(v->>'ord')::int,v->>'text',v->>'context_header',(v->>'span_start')::int,(v->>'span_end')::int,
          (v->>'token_count')::int,v->'source_ranges',decode(v->>'text_hash','hex'),decode(v->>'embedding_input_hash','hex'),
          o.embedding,o.embed_model,o.embed_dim,o.embedded_at
          from jsonb_array_elements($4::jsonb) v
          left join old o on o.embedding_input_hash=decode(v->>'embedding_input_hash','hex')`,
        [p.documentId, p.container, p.orgId, JSON.stringify(added), p.revision],
      );

    const diff: RevisionDiff = {
      from: previous,
      to: p.revision,
      kept: kept.length,
      added: added.length,
      removed: removed.length,
      moved: kept.filter((x) => x.prevOrd !== x.ord).length,
    };
    // A re-run of this stage on the same revision finds its own rows and
    // would report a no-op; the diff that matters is the one against the
    // previous revision, so it is only written once.
    if (previous !== p.revision)
      await c.query(
        "update documents set metadata=metadata||jsonb_build_object('diff',$2::jsonb),updated_at=now() where id=$1",
        [p.documentId, JSON.stringify(diff)],
      );
    ctx.log.info("chunked", {
      documentId: p.documentId,
      chunks: chunks.length,
      ...diff,
      maxTokens: Math.max(...chunks.map((k) => k.tokenCount)),
    });
  });
}

type Positional = {
  ord: number;
  span_start: number;
  span_end: number;
  token_count: number;
  source_ranges: unknown;
};
type NewRow = {
  text: string;
  context_header: string | null;
  text_hash: string;
  embedding_input_hash: string;
};
