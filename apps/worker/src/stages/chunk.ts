import type { Job, Section } from "@memwe/contracts";
import { DocumentJobPayload, MemweError } from "@memwe/contracts";
import { tx } from "@memwe/db";
import { chunkDocument, contextHeader } from "../chunk/index.js";
import type { StageContext } from "./index.js";

type Row = {
  markdown: string | null;
  title: string | null;
  org_id: string;
  container: string;
  metadata: { sections?: Section[] } | null;
};

/**
 * Stage 04 — chunk.
 *
 * Splits the normalized markdown on its section tree and packs to a token
 * budget. Chunks carry the markdown offsets they came from, so a chunk
 * resolves through the document's span map back to a page and a bounding
 * box without storing anything twice.
 */
export async function chunkStage(job: Job, ctx: StageContext): Promise<void> {
  const p = DocumentJobPayload.parse(job.payload);

  const row = await tx(async (c) => {
    const r = await c.query<Row>(
      `select markdown, title, org_id::text, container, metadata
         from documents where id = $1`,
      [p.documentId],
    );
    return r.rows[0];
  });
  if (!row) throw new MemweError("not_found", `document ${p.documentId} vanished`);
  if (!row.markdown || row.markdown.trim().length === 0) {
    throw new MemweError("unsupported_content", "nothing to chunk — extraction produced no text");
  }

  const doc = {
    title: row.title,
    markdown: row.markdown,
    sections: row.metadata?.sections ?? [],
  };

  const chunks = chunkDocument(doc as never, ctx.log);
  if (chunks.length === 0) {
    throw new MemweError("unsupported_content", "chunking produced nothing");
  }

  await tx(async (c) => {
    // Re-chunking must replace, not append. A document revised in place
    // would otherwise accumulate every generation of its chunks and return
    // stale text from search forever.
    await c.query(`delete from chunks where document_id = $1 and container = $2`, [
      p.documentId,
      row.container,
    ]);

    // One statement, not one per chunk: a 400-page PDF is thousands of
    // round trips otherwise.
    await c.query(
      `insert into chunks (document_id, org_id, container, ord, text, context_header,
                           span_start, span_end, token_count)
       select $1, $2, $3,
              (v->>'ord')::int, v->>'text', v->>'context_header',
              (v->>'span_start')::int, (v->>'span_end')::int, (v->>'token_count')::int
         from jsonb_array_elements($4::jsonb) as v`,
      [
        p.documentId,
        row.org_id,
        row.container,
        JSON.stringify(
          chunks.map((k) => ({
            ord: k.ord,
            text: k.text,
            context_header: contextHeader(doc as never, k),
            span_start: k.spanStart,
            span_end: k.spanEnd,
            token_count: k.tokenCount,
          })),
        ),
      ],
    );
  });

  const counts = chunks.map((k) => k.tokenCount).sort((a, b) => a - b);
  ctx.log.info("chunked", {
    documentId: p.documentId,
    chunks: chunks.length,
    medianTokens: counts[Math.floor(counts.length / 2)],
    minTokens: counts[0],
    maxTokens: counts[counts.length - 1],
    withOverlap: chunks.filter((k) => k.overlapTokens > 0).length,
  });
}
