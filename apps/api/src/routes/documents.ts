import { createHash, randomUUID } from "node:crypto";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  assertFetchableUrl,
  type BatchIngestItem,
  BatchIngestRequest,
  BatchIngestResponse,
  DocumentDetail,
  DocumentList,
  ErrorResponse,
  IngestRequest,
  IngestResponse,
  MemweError,
  UploadRequest,
  UploadResponse,
} from "@memwe/contracts";
import { lockIngestion, withTenant } from "@memwe/db";
import { blobKey, copyObject, objectExists, presignedPut } from "@memwe/storage";
import type { Principal } from "../auth.js";
import { assertContainerAllowed } from "../auth.js";
import { enqueue } from "../queue-client.js";

type Env = { Variables: { principal: Principal; traceId: string } };

export const documents = new OpenAPIHono<Env>();

const json = (schema: z.ZodTypeAny, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const errors = {
  400: json(ErrorResponse, "Validation failed"),
  401: json(ErrorResponse, "Missing or invalid API key"),
  403: json(ErrorResponse, "Key is not scoped to this container"),
  404: json(ErrorResponse, "Not found"),
};

const UPLOAD_TTL = 900;

// ---------------------------------------------------------------- ingest
const ingestRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["documents"],
  summary: "Ingest a document",
  description:
    "Accepts text or a URL and returns 202 immediately. Text is deduped by content hash; " +
    "a URL is deduped by address now and by fetched content once the worker has it. " +
    "The pipeline runs asynchronously; poll the document for status.",
  request: { body: { content: { "application/json": { schema: IngestRequest } } } },
  responses: { 202: json(IngestResponse, "Accepted for processing"), ...errors },
});

documents.openapi(ingestRoute, async (c) => {
  const result = await ingestOne(c.get("principal"), c.req.valid("json"), c.get("traceId"));
  return c.json(result, 202);
});

/** One document, by text or by address. Shared by the single and batch routes. */
async function ingestOne(
  p: Principal,
  body: IngestRequest,
  traceId: string,
): Promise<IngestResponse> {
  assertContainerAllowed(p, body.container);
  const hasContent = Boolean(body.content?.trim());
  if (hasContent === Boolean(body.url)) {
    throw new MemweError("invalid_request", "exactly one of content or url is required");
  }
  const result = body.url
    ? await ingestUrl(p, body.url, body, traceId)
    : await ingestContent(p, body, traceId);
  return IngestResponse.parse(result);
}

async function ingestContent(p: Principal, body: IngestRequest, traceId: string) {
  const contentHash = createHash("sha256").update(body.content!).digest();
  const result = await withTenant(
    { orgId: p.orgId, container: body.container, containerScope: p.containerScope },
    async (client) => {
      await lockIngestion(client, p.orgId, body.container);
      const prior = body.customId
        ? (
            await client.query<{
              id: string;
              status: string;
              revision: number;
              content_hash: Buffer;
              title: string | null;
              metadata: unknown;
            }>(
              `select id::text,status::text,revision,content_hash,title,metadata from documents
       where custom_id=$1 and org_id=$2 and container=$3 for update`,
              [body.customId, p.orgId, body.container],
            )
          ).rows[0]
        : undefined;
      if (
        prior?.content_hash.equals(contentHash) &&
        (body.title === undefined || body.title === prior.title) &&
        (body.metadata === undefined ||
          JSON.stringify(body.metadata) === JSON.stringify(prior.metadata))
      ) {
        return {
          id: prior.id,
          status: prior.status,
          revision: prior.revision,
          deduped: true,
          revised: false,
        };
      }
      const found = (
        await client.query<{ id: string; status: string; revision: number }>(
          `select id::text,status::text,revision from documents where org_id=$1 and container=$2
       and content_hash=$3 and ($4::uuid is null or id<>$4)
       order by (duplicate_of is null) desc, created_at, id limit 1`,
          [p.orgId, body.container, contentHash, prior?.id ?? null],
        )
      ).rows[0];
      if (found && !body.customId) {
        return { ...found, deduped: true, revised: false };
      }
      const id = prior?.id ?? randomUUID();
      const revision = (prior?.revision ?? 0) + 1;
      if (prior) {
        await client.query(
          `update documents set source_content=$2,markdown=$2,source_uri=null,
        content_hash=$3,mime='text/markdown',title=coalesce($4,title),metadata=$5,span_map=null,
        blob_key=null,upload_pending_key=null,duplicate_of=$6,revision=$7,status='queued',
        stage_error=null,failed_stage=null,token_count=null,status_changed_at=now(),updated_at=now()
        where id=$1`,
          [
            id,
            body.content,
            contentHash,
            body.title ?? null,
            body.metadata ?? {},
            found?.id ?? null,
            revision,
          ],
        );
      } else {
        await client.query(
          `insert into documents
        (id,org_id,container,custom_id,title,source_content,markdown,content_hash,mime,source,metadata,status,duplicate_of)
        values ($1,$2,$3,$4,$5,$6,$6,$7,'text/markdown','api',$8,'queued',$9)`,
          [
            id,
            p.orgId,
            body.container,
            body.customId ?? null,
            body.title ?? null,
            body.content,
            contentHash,
            body.metadata ?? {},
            found?.id ?? null,
          ],
        );
      }
      await enqueue(client, {
        type: "document.accept",
        payload: { orgId: p.orgId, container: body.container, traceId, documentId: id, revision },
        traceId,
        dedupeKey: `document.accept:${id}:${revision}`,
      });
      return { id, status: "queued", deduped: false, revision, revised: Boolean(prior) };
    },
  );

  return result;
}

// ----------------------------------------------------------------- batch
const batchRoute = createRoute({
  method: "post",
  path: "/batch",
  tags: ["documents"],
  summary: "Ingest many documents in one request",
  description:
    "Up to 100 items, each the shape of a single ingest. Items are processed in order and " +
    "each answers on its own: a rejected item does not undo the ones before it, and results " +
    "come back in the order sent. The request is 400 only when an item is malformed.",
  request: { body: { content: { "application/json": { schema: BatchIngestRequest } } } },
  responses: { 202: json(BatchIngestResponse, "Per-item results"), ...errors },
});

documents.openapi(batchRoute, async (c) => {
  const p = c.get("principal");
  const traceId = c.get("traceId");
  const { items } = c.req.valid("json");
  const results: BatchIngestItem[] = [];
  for (const [index, item] of items.entries()) {
    try {
      // The trace threads through every job; the suffix says which item.
      results.push({ index, result: await ingestOne(p, item, `${traceId}:${index}`) });
    } catch (err) {
      // A per-document refusal is an outcome; anything else is ours and aborts the batch.
      if (!(err instanceof MemweError) || err.code === "internal") throw err;
      results.push({ index, error: { code: err.code, message: err.message } });
    }
  }
  const failed = results.filter((r) => r.error).length;
  return c.json(
    BatchIngestResponse.parse({ results, accepted: results.length - failed, failed }),
    202,
  );
});

/**
 * A URL has no bytes yet, so it cannot be deduped by hash here; the worker
 * does that once it has fetched them. What can be decided now: the same
 * address in the same container is the same document unless a customId
 * says otherwise, and an address we would never fetch is a 400, not a
 * document that fails later.
 */
async function ingestUrl(
  p: Principal,
  url: string,
  body: Pick<IngestRequest, "container" | "customId" | "title" | "metadata">,
  traceId: string,
) {
  const href = assertFetchableUrl(url, {
    allowPrivate: process.env["URL_ALLOW_PRIVATE"] === "true",
  }).href;
  return withTenant(
    { orgId: p.orgId, container: body.container, containerScope: p.containerScope },
    async (client) => {
      await lockIngestion(client, p.orgId, body.container);
      const prior = body.customId
        ? (
            await client.query<{ id: string; revision: number }>(
              `select id::text,revision from documents where custom_id=$1 and org_id=$2 and container=$3 for update`,
              [body.customId, p.orgId, body.container],
            )
          ).rows[0]
        : (
            await client.query<{ id: string; status: string; revision: number }>(
              `select id::text,status::text,revision from documents
              where org_id=$1 and container=$2 and source='url' and source_uri=$3 and custom_id is null
              order by created_at,id limit 1`,
              [p.orgId, body.container, href],
            )
          ).rows[0];
      if (prior && !body.customId && "status" in prior) {
        return {
          id: prior.id,
          status: prior.status,
          revision: prior.revision,
          deduped: true,
          revised: false,
        };
      }
      const id = prior?.id ?? randomUUID();
      const revision = (prior?.revision ?? 0) + 1;
      // Unique per document revision until the fetched bytes replace it.
      const placeholder = createHash("sha256").update(`url\0${href}\0${id}\0${revision}`).digest();
      if (prior) {
        await client.query(
          `update documents set source='url',source_uri=$2,source_content=null,markdown=null,blob_key=null,
          upload_pending_key=null,content_hash=$3,mime=null,title=$4,metadata=$5,span_map=null,duplicate_of=null,
          revision=$6,status='queued',stage_error=null,failed_stage=null,token_count=null,
          status_changed_at=now(),updated_at=now() where id=$1`,
          [id, href, placeholder, body.title ?? null, body.metadata ?? {}, revision],
        );
      } else {
        await client.query(
          `insert into documents (id,org_id,container,custom_id,title,source_uri,content_hash,source,metadata,status)
          values ($1,$2,$3,$4,$5,$6,$7,'url',$8,'queued')`,
          [
            id,
            p.orgId,
            body.container,
            body.customId ?? null,
            body.title ?? null,
            href,
            placeholder,
            body.metadata ?? {},
          ],
        );
      }
      await enqueue(client, {
        type: "document.accept",
        payload: { orgId: p.orgId, container: body.container, traceId, documentId: id, revision },
        traceId,
        dedupeKey: `document.accept:${id}:${revision}`,
      });
      return { id, status: "queued", deduped: false, revision, revised: Boolean(prior) };
    },
  );
}

// ---------------------------------------------------------------- upload
const uploadRoute = createRoute({
  method: "post",
  path: "/upload",
  tags: ["documents"],
  summary: "Request a presigned upload URL",
  description:
    "Returns a URL to PUT the file bytes to directly. The file never passes through " +
    "the API. Call /upload/{id}/complete once the PUT succeeds.",
  request: { body: { content: { "application/json": { schema: UploadRequest } } } },
  responses: { 200: json(UploadResponse, "Presigned URL issued"), ...errors },
});

documents.openapi(uploadRoute, async (c) => {
  const p = c.get("principal");
  const body = c.req.valid("json");
  assertContainerAllowed(p, body.container);

  const result = await withTenant(
    { orgId: p.orgId, container: body.container, containerScope: p.containerScope },
    async (client) => {
      await lockIngestion(client, p.orgId, body.container);
      const prior = body.customId
        ? (
            await client.query<{ id: string; revision: number }>(
              `select id::text,revision from documents where org_id=$1 and container=$2 and custom_id=$3 for update`,
              [p.orgId, body.container, body.customId],
            )
          ).rows[0]
        : undefined;
      const id = prior?.id ?? randomUUID();
      const revision = (prior?.revision ?? 0) + 1;
      const key = `${blobKey(p.orgId, id)}/${revision}/${randomUUID()}`;
      const hash = createHash("sha256").update(key).digest();
      const uploadUrl = await presignedPut(key, body.contentType, UPLOAD_TTL);
      if (prior) {
        await client.query(
          `update documents set source='upload',source_content=null,markdown=null,source_uri=null,
        blob_key=null,upload_pending_key=$2,content_hash=$3,mime=$4,title=$5,duplicate_of=null,
        revision=$6,status='queued',span_map=null,metadata='{}',stage_error=null,failed_stage=null,
        token_count=null,status_changed_at=now(),updated_at=now() where id=$1`,
          [id, key, hash, body.contentType, body.filename, revision],
        );
      } else {
        await client.query(
          `insert into documents
        (id,org_id,container,custom_id,title,upload_pending_key,content_hash,mime,source,status)
        values ($1,$2,$3,$4,$5,$6,$7,$8,'upload','queued')`,
          [
            id,
            p.orgId,
            body.container,
            body.customId ?? null,
            body.filename,
            key,
            hash,
            body.contentType,
          ],
        );
      }
      return { id, revision, uploadUrl, expiresInSeconds: UPLOAD_TTL };
    },
  );
  return c.json(UploadResponse.parse(result), 200);
});

const completeRoute = createRoute({
  method: "post",
  path: "/upload/{id}/complete",
  tags: ["documents"],
  summary: "Confirm an upload and start processing",
  request: {
    params: z.object({ id: z.guid() }),
    query: z.object({ revision: z.coerce.number().int().positive().default(1) }),
  },
  responses: { 202: json(IngestResponse, "Queued for processing"), ...errors },
});

documents.openapi(completeRoute, async (c) => {
  const p = c.get("principal");
  const traceId = c.get("traceId");
  const { id } = c.req.valid("param");

  const { revision } = c.req.valid("query");
  const tenant = { orgId: p.orgId, containerScope: p.containerScope };
  const doc = await withTenant(
    tenant,
    async (client) =>
      (
        await client.query<{
          container: string;
          upload_pending_key: string | null;
          revision: number;
          status: string;
        }>(`select container,upload_pending_key,revision,status::text from documents where id=$1`, [
          id,
        ])
      ).rows[0],
  );
  if (!doc) throw new MemweError("not_found", "document not found");
  assertContainerAllowed(p, doc.container);
  if (doc.revision !== revision) throw new MemweError("conflict", "upload revision is obsolete");
  if (!doc.upload_pending_key) {
    return c.json(IngestResponse.parse({ id, revision, status: doc.status, deduped: true }), 202);
  }
  if (!(await objectExists(doc.upload_pending_key)))
    throw new MemweError("invalid_request", "upload object is missing");
  // A PUT URL may remain usable after completion. Workers read a sealed snapshot.
  const sealed = `${doc.upload_pending_key}/sealed/${randomUUID()}`;
  await copyObject(doc.upload_pending_key, sealed);
  const result = await withTenant(tenant, async (client) => {
    await lockIngestion(client, p.orgId, doc.container);
    const updated = await client.query(
      `update documents set blob_key=$3,upload_pending_key=null
      where id=$1 and revision=$2 and upload_pending_key=$4 returning id`,
      [id, revision, sealed, doc.upload_pending_key],
    );
    if (!updated.rowCount) throw new MemweError("conflict", "upload already completed or revised");
    await enqueue(client, {
      type: "document.accept",
      payload: { orgId: p.orgId, container: doc.container, traceId, documentId: id, revision },
      traceId,
      dedupeKey: `document.accept:${id}:${revision}`,
    });
    return { id, revision, status: "queued", deduped: false };
  });
  return c.json(IngestResponse.parse(result), 202);
});

// ------------------------------------------------------------------ read
const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["documents"],
  summary: "Get a document",
  request: { params: z.object({ id: z.guid() }) },
  responses: { 200: json(DocumentDetail, "The document"), ...errors },
});

documents.openapi(getRoute, async (c) => {
  const p = c.get("principal");
  const { id } = c.req.valid("param");
  const rows = await withTenant(
    { orgId: p.orgId, containerScope: p.containerScope },
    async (client) => {
      const r = await client.query(
        `select id::text, container, title, status::text, token_count, stage_error,
              failed_stage, duplicate_of::text, revision, status_changed_at, created_at, updated_at,
              metadata->'extraction' as extraction,
              metadata->'diff' as diff,
              -- Position through the pipeline, computed here so a caller
              -- never has to know the stage names to draw a progress bar.
              case status
                when 'queued'     then 0.0
                when 'extracting' then 0.2
                when 'chunking'   then 0.4
                when 'embedding'  then 0.6
                when 'indexing'   then 0.8
                when 'done'       then 1.0
                when 'failed'     then 1.0
              end::float8 as progress
         from documents where id = $1`,
        [id],
      );
      return r.rows;
    },
  );
  const doc = rows[0];
  if (!doc) throw new MemweError("not_found", "document not found");
  return c.json(DocumentDetail.parse(doc), 200);
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["documents"],
  summary: "List documents",
  request: { query: z.object({ container: z.string().optional() }) },
  responses: { 200: json(DocumentList, "Up to 50 documents, newest first"), ...errors },
});

documents.openapi(listRoute, async (c) => {
  const p = c.get("principal");
  const { container } = c.req.valid("query");
  if (container) assertContainerAllowed(p, container);
  const rows = await withTenant(
    { orgId: p.orgId, containerScope: p.containerScope },
    async (client) => {
      const r = await client.query(
        `select id::text, container, title, status::text, created_at
         from documents
        where ($1::text is null or container = $1)
        order by created_at desc limit 50`,
        [container ?? null],
      );
      return r.rows;
    },
  );
  return c.json(DocumentList.parse({ documents: rows }), 200);
});
