import { createHash } from "node:crypto";
import type { Acl, Job, TrustTier } from "@memwe/contracts";
import { DocumentJobPayload, MemweError } from "@memwe/contracts";
import { tx } from "@memwe/db";
import { getObject } from "@memwe/storage";
import { extract } from "../extract/index.js";
import type { StageContext, StageResult } from "./index.js";

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
export async function extractStage(job: Job, ctx: StageContext): Promise<StageResult> {
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

  // The real content hash, computed where the bytes actually are.
  //
  // /upload cannot know it: it hands out a presigned URL before any bytes
  // exist, so it stamps a placeholder derived from the blob key. That
  // placeholder is unique per document by construction, which meant the
  // same file uploaded twice was extracted, chunked and embedded twice.
  if (row.blob_key) {
    const realHash = createHash("sha256").update(bytes).digest();
    const duplicate = await tx(async (c) => {
      const r = await c.query<{ id: string }>(
        `select id::text from documents
          where org_id = $1 and container = $2 and content_hash = $3
            and duplicate_of is null and id <> $4`,
        [row.org_id, row.container, realHash, p.documentId],
      );
      return r.rows[0]?.id ?? null;
    });

    if (duplicate) {
      // Keep the row rather than deleting it — the caller holds this id and
      // deserves an answer, not a 404. Point it at the original and stop.
      await tx(async (c) => {
        await c.query(
          `update documents
              set duplicate_of = $2, status = 'done',
                  status_changed_at = now(), updated_at = now()
            where id = $1`,
          [p.documentId, duplicate],
        );
      });
      ctx.log.info("duplicate upload", { documentId: p.documentId, duplicateOf: duplicate });
      return { halt: true, reason: `identical bytes already stored as ${duplicate}` };
    }

    await tx(async (c) => {
      await c.query(`update documents set content_hash = $2 where id = $1`, [
        p.documentId,
        realHash,
      ]);
    });
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
