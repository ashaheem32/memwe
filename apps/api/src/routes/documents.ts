import { createHash, randomUUID } from "node:crypto";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  DocumentDetail,
  DocumentList,
  ErrorResponse,
  IngestRequest,
  IngestResponse,
  MemweError,
  UploadRequest,
  UploadResponse,
} from "@memwe/contracts";
import { withTenant } from "@memwe/db";
import { blobKey, objectExists, presignedPut } from "@memwe/storage";
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
    "Accepts text or a URL, dedupes by content hash, and returns 202 immediately. " +
    "The pipeline runs asynchronously; poll the document for status.",
  request: { body: { content: { "application/json": { schema: IngestRequest } } } },
  responses: { 202: json(IngestResponse, "Accepted for processing"), ...errors },
});

documents.openapi(ingestRoute, async (c) => {
  const p = c.get("principal");
  const traceId = c.get("traceId");
  const body = c.req.valid("json");
  assertContainerAllowed(p, body.container);

  if (!body.content && !body.url) {
    throw new MemweError("invalid_request", "one of `content` or `url` is required");
  }

  const contentHash = createHash("sha256")
    .update(body.content ?? body.url ?? "")
    .digest();

  // withTenant, never pool.query: RLS is the isolation boundary, and a
  // WHERE clause you have to remember is not a boundary at all.
  const result = await withTenant({ orgId: p.orgId, container: body.container }, async (client) => {
    // Identical bytes: hand back the existing id. Nothing is re-processed
    // and nothing is re-billed.
    const existing = await client.query<{ id: string; status: string; revision: number }>(
      `select id::text, status::text, revision from documents
          where org_id = $1 and container = $2 and content_hash = $3 and duplicate_of is null`,
      [p.orgId, body.container, contentHash],
    );
    const found = existing.rows[0];
    if (found) {
      return {
        id: found.id,
        status: found.status,
        deduped: true,
        revision: found.revision,
        revised: false,
      };
    }

    // Same customId, different bytes: a revision, not a conflict. Before
    // this the unique index simply raised and the caller got a 500.
    if (body.customId) {
      const prior = await client.query<{ id: string; revision: number }>(
        `select id::text, revision from documents
            where org_id = $1 and container = $2 and custom_id = $3`,
        [p.orgId, body.container, body.customId],
      );
      const doc = prior.rows[0];
      if (doc) {
        // The id stays stable — that is the whole point of customId — and
        // everything derived from the old content is cleared so the
        // pipeline cannot serve a mix of two versions.
        await client.query(
          `update documents
                set markdown = $2, source_uri = $3, content_hash = $4, mime = $5,
                    title = coalesce($6, title),
                    metadata = $7, span_map = null, blob_key = null,
                    revision = revision + 1, status = 'queued',
                    stage_error = null, failed_stage = null,
                    token_count = null,
                    status_changed_at = now(), updated_at = now()
              where id = $1`,
          [
            doc.id,
            body.content ?? null,
            body.url ?? null,
            contentHash,
            body.content ? "text/markdown" : "text/html",
            body.title ?? null,
            body.metadata ?? {},
          ],
        );
        return {
          id: doc.id,
          status: "queued",
          deduped: false,
          revision: doc.revision + 1,
          revised: true,
        };
      }
    }

    const id = randomUUID();
    await client.query(
      `insert into documents (id, org_id, container, custom_id, title, markdown, source_uri,
                                content_hash, mime, source, metadata, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'api',$10,'queued')`,
      [
        id,
        p.orgId,
        body.container,
        body.customId ?? null,
        body.title ?? null,
        body.content ?? null,
        body.url ?? null,
        contentHash,
        body.content ? "text/markdown" : "text/html",
        body.metadata ?? {},
      ],
    );
    return { id, status: "queued", deduped: false, revision: 1, revised: false };
  });

  if (!result.deduped) {
    await enqueue({
      type: "document.accept",
      payload: { orgId: p.orgId, container: body.container, traceId, documentId: result.id },
      traceId,
      dedupeKey: `accept:${result.id}`,
    });
  }

  return c.json(IngestResponse.parse(result), 202);
});

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

  const id = randomUUID();
  const key = blobKey(p.orgId, id);

  // A placeholder: the presigned URL is issued before any bytes exist, so
  // there is nothing to hash yet. The extract stage replaces this with the
  // real content hash once it reads the blob, and that is where dedupe for
  // uploads happens — it cannot happen here.
  const placeholderHash = createHash("sha256").update(key).digest();

  await withTenant({ orgId: p.orgId, container: body.container }, async (client) => {
    await client.query(
      `insert into documents (id, org_id, container, custom_id, title, blob_key,
                              content_hash, mime, source, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'upload','queued')`,
      [
        id,
        p.orgId,
        body.container,
        body.customId ?? null,
        body.filename,
        key,
        placeholderHash,
        body.contentType,
      ],
    );
  });

  return c.json(
    UploadResponse.parse({
      id,
      uploadUrl: await presignedPut(key, body.contentType, UPLOAD_TTL),
      expiresInSeconds: UPLOAD_TTL,
    }),
    200,
  );
});

const completeRoute = createRoute({
  method: "post",
  path: "/upload/{id}/complete",
  tags: ["documents"],
  summary: "Confirm an upload and start processing",
  request: { params: z.object({ id: z.guid() }) },
  responses: { 202: json(IngestResponse, "Queued for processing"), ...errors },
});

documents.openapi(completeRoute, async (c) => {
  const p = c.get("principal");
  const traceId = c.get("traceId");
  const { id } = c.req.valid("param");

  const doc = await withTenant({ orgId: p.orgId }, async (client) => {
    const r = await client.query<{ id: string; container: string; blob_key: string | null }>(
      `select id::text, container, blob_key from documents where id = $1`,
      [id],
    );
    return r.rows[0];
  });
  if (!doc) throw new MemweError("not_found", "document not found");
  if (!doc.blob_key) throw new MemweError("invalid_request", "document has no pending upload");

  // Trust the storage layer, not the client's word that the PUT worked.
  if (!(await objectExists(doc.blob_key))) {
    throw new MemweError(
      "invalid_request",
      "no object at the presigned key — did the PUT succeed?",
    );
  }

  await enqueue({
    type: "document.accept",
    payload: { orgId: p.orgId, container: doc.container, traceId, documentId: id },
    traceId,
    dedupeKey: `accept:${id}`,
  });

  return c.json(IngestResponse.parse({ id, status: "queued", deduped: false }), 202);
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
  const rows = await withTenant({ orgId: p.orgId }, async (client) => {
    const r = await client.query(
      `select id::text, container, title, status::text, token_count, stage_error,
              failed_stage, duplicate_of::text, revision, status_changed_at, created_at, updated_at,
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
  });
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
  const rows = await withTenant({ orgId: p.orgId }, async (client) => {
    const r = await client.query(
      `select id::text, container, title, status::text, created_at
         from documents
        where ($1::text is null or container = $1)
        order by created_at desc limit 50`,
      [container ?? null],
    );
    return r.rows;
  });
  return c.json(DocumentList.parse({ documents: rows }), 200);
});
