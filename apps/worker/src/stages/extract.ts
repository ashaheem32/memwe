import type { Acl, Job, TrustTier } from "@memwe/contracts";
import { DocumentJobPayload, MemweError } from "@memwe/contracts";
import { tx } from "@memwe/db";
import { getObject } from "@memwe/storage";
import { extract } from "../extract/index.js";
import type { StageContext } from "./index.js";

type Row = {
  blob_key: string | null;
  markdown: string | null;
  source_uri: string | null;
  mime: string | null;
  title: string | null;
  container: string;
  org_id: string;
  acl: Acl;
  trust: TrustTier;
};

/**
 * Stage 02 — extract.
 *
 * Bytes in, NormalizedDoc out. Everything format-specific stops here: the
 * rest of the pipeline only ever sees markdown, a span map and a section
 * tree, which is what keeps adding a connector from touching chunking.
 */
export async function extractStage(job: Job, ctx: StageContext): Promise<void> {
  const p = DocumentJobPayload.parse(job.payload);

  const row = await tx(async (c) => {
    const r = await c.query<Row>(
      `select blob_key, markdown, source_uri, mime, title, container, org_id::text,
              acl, trust::text as trust
         from documents where id = $1`,
      [p.documentId],
    );
    return r.rows[0];
  });
  if (!row) throw new MemweError("not_found", `document ${p.documentId} vanished`);

  // Where the bytes come from, in order of authority.
  let bytes: Buffer;
  if (row.blob_key) {
    bytes = await getObject(row.blob_key);
  } else if (row.markdown !== null) {
    bytes = Buffer.from(row.markdown, "utf8");
  } else if (row.source_uri) {
    // Sprint 1, next task. Fail clean rather than pretend.
    throw new MemweError("unsupported_content", "URL fetching is not implemented yet");
  } else {
    throw new MemweError("unsupported_content", "document has no content, blob or URL");
  }

  const { doc, stats } = await extract(
    {
      bytes,
      declaredMime: row.mime,
      filename: row.title,
      // Carried through, not invented. The ACL-intersection rule and the
      // never-inject-untrusted-text rule both read these off the memories
      // that eventually derive from this document.
      sourceUri: row.source_uri,
      acl: row.acl,
      trust: row.trust,
    },
    ctx.log,
  );

  await tx(async (c) => {
    await c.query(
      `update documents
          set markdown = $2,
              span_map = $3,
              mime = $4,
              title = coalesce(nullif($5, ''), title),
              token_count = $6,
              metadata = metadata || $7::jsonb,
              stage_error = null,
              updated_at = now()
        where id = $1`,
      [
        p.documentId,
        doc.markdown,
        JSON.stringify(doc.spanMap),
        doc.mime,
        doc.title ?? "",
        // Rough until a real tokenizer lands with embedding in Sprint 1.
        Math.ceil(doc.markdown.length / 4),
        JSON.stringify({ extraction: stats, sections: doc.sections }),
      ],
    );
  });

  ctx.log.info("extracted", { documentId: p.documentId, ...stats });
}
