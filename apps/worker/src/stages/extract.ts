import { createHash, randomUUID } from "node:crypto";
import {
  type Acl,
  DocumentJobPayload,
  type Job,
  MemweError,
  type TrustTier,
} from "@memwe/contracts";
import { blobKey, getObject, putObject } from "@memwe/storage";
import { tokens } from "../chunk/tokens.js";
import { extract } from "../extract/index.js";
import { fetchConfig, fetchUrl } from "../fetch/index.js";
import { documentTx } from "./guard.js";
import type { StageContext, StageResult } from "./index.js";

type Row = {
  blob_key: string | null;
  source_content: string | null;
  markdown: string | null;
  source: string;
  source_uri: string | null;
  mime: string | null;
  title: string | null;
  acl: Acl;
  trust: TrustTier;
  metadata: { fetch?: { charset?: string | null } };
};

export async function extractStage(job: Job, ctx: StageContext): Promise<StageResult> {
  const p = DocumentJobPayload.parse(job.payload);
  const row = await documentTx(
    job,
    async (c) =>
      (
        await c.query<Row>(
          `select blob_key,source_content,markdown,source,source_uri,mime,title,acl,trust,metadata
             from documents where id=$1`,
          [p.documentId],
        )
      ).rows[0]!,
  );
  let bytes: Buffer;
  if (row.blob_key) bytes = await getObject(row.blob_key);
  else if (row.source === "url" && row.source_uri) bytes = await fetchSource(job, row, ctx);
  else if (row.source_content !== null || row.markdown !== null)
    bytes = Buffer.from(row.source_content ?? row.markdown!, "utf8");
  else throw new MemweError("unsupported_content", "document has no content");
  const realHash = createHash("sha256").update(bytes).digest();
  const reused = await documentTx(job, async (c) => {
    // The shared container lock makes the hash claim and duplicate lookup atomic.
    const original = (
      await c.query<{
        id: string;
        status: string;
        markdown: string | null;
        span_map: unknown;
        mime: string;
        metadata: Record<string, unknown>;
        token_count: number | null;
      }>(
        `select id::text,status::text,markdown,span_map,mime,metadata,token_count from documents
      where org_id=$1 and container=$2 and content_hash=$3 and duplicate_of is null and id<>$4
      order by created_at,id limit 1`,
        [p.orgId, p.container, realHash, p.documentId],
      )
    ).rows[0];
    await c.query(
      `update documents set content_hash=$2,duplicate_of=$3,
      source_content=case when blob_key is null then coalesce(source_content,markdown) else source_content end
      where id=$1`,
      [p.documentId, realHash, original?.id ?? null],
    );
    if (original && original.status !== "done" && original.status !== "failed") {
      // Returning commits the hash claim. The retry below waits for the canonical extraction.
      return { waiting: true } as const;
    }
    if (original?.status === "done" && original.markdown && original.span_map) {
      const stats = original.metadata.extraction as Record<string, unknown> | undefined;
      await c.query(
        `update documents set markdown=$2,span_map=$3,mime=$4,title=$5,token_count=$6,
        metadata=metadata || $7::jsonb,stage_error=null,updated_at=now() where id=$1`,
        [
          p.documentId,
          original.markdown,
          JSON.stringify(original.span_map),
          original.mime,
          stats?.contentTitle ?? row.title,
          original.token_count,
          JSON.stringify({
            sections: original.metadata.sections ?? [],
            extraction: { ...stats, reusedFrom: original.id },
          }),
        ],
      );
      return { reused: true } as const;
    }
    return null;
  });
  if (reused && "waiting" in reused) return { deferMs: 2000 };
  if (reused) {
    ctx.log.info("reused extraction", { documentId: p.documentId });
    return;
  }
  const { doc, stats } = await extract(
    {
      bytes,
      declaredMime: row.mime,
      charset: row.metadata.fetch?.charset ?? null,
      filename: row.title,
      sourceUri: row.source_uri,
      acl: row.acl,
      trust: row.trust,
    },
    ctx.log,
  );
  await documentTx(job, async (c) => {
    await c.query(
      `update documents set markdown=$2,span_map=$3,mime=$4,title=coalesce(nullif($5,''),title),
      token_count=$6,metadata=metadata || $7::jsonb,stage_error=null,updated_at=now() where id=$1`,
      [
        p.documentId,
        doc.markdown,
        JSON.stringify(doc.spanMap),
        doc.mime,
        doc.title ?? "",
        tokens.count(doc.markdown),
        JSON.stringify({ extraction: stats, sections: doc.sections }),
      ],
    );
  });
  ctx.log.info("extracted", { documentId: p.documentId, ...stats });
}

/**
 * A URL document has no bytes until here. Fetch them once, keep the
 * snapshot in blob storage under this revision, and record how the fetch
 * went on the row. From then on the document is an upload: retries,
 * dedupe by hash, and reprocessing all read the snapshot, never the site.
 */
async function fetchSource(job: Job, row: Row, ctx: StageContext): Promise<Buffer> {
  const p = DocumentJobPayload.parse(job.payload);
  // Check before spending network time, then fence the write again after.
  await documentTx(job, async () => {});
  const fetched = await fetchUrl(row.source_uri!, fetchConfig(), ctx.log);
  const key = `${blobKey(p.orgId, p.documentId)}/${p.revision}/fetch/${randomUUID()}`;
  await putObject(key, fetched.bytes, fetched.contentType ?? undefined);
  const stats = {
    finalUrl: fetched.finalUrl,
    status: fetched.status,
    via: fetched.via,
    rendered: fetched.rendered ?? null,
    redirects: fetched.redirects,
    contentType: fetched.contentType,
    charset: fetched.charset,
    bytes: fetched.bytes.byteLength,
    elapsedMs: fetched.elapsedMs,
    fetchedAt: new Date().toISOString(),
  };
  await documentTx(job, async (c) => {
    await c.query(
      `update documents set blob_key=$2,mime=$3,metadata=metadata||jsonb_build_object('fetch',$4::jsonb),
        updated_at=now() where id=$1`,
      [p.documentId, key, fetched.contentType, JSON.stringify(stats)],
    );
  });
  row.blob_key = key;
  row.mime = fetched.contentType;
  row.metadata = { ...row.metadata, fetch: { charset: fetched.charset } };
  ctx.log.info("fetched", { documentId: p.documentId, ...stats });
  return fetched.bytes;
}
