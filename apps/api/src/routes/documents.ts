import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { withTenant } from "@memwe/db";
import { IngestRequest, MemweError } from "@memwe/contracts";
import { assertContainerAllowed } from "../auth.js";
import type { Principal } from "../auth.js";
import { enqueue } from "../queue-client.js";

type Env = { Variables: { principal: Principal; traceId: string } };

export const documents = new Hono<Env>();

/**
 * POST /v1/documents — accept, dedupe, enqueue, return 202 in under 40ms.
 * The whole pipeline is asynchronous behind this; the document row is
 * the state machine.
 */
documents.post("/", async (c) => {
  const p = c.get("principal");
  const traceId = c.get("traceId");
  const body = IngestRequest.parse(await c.req.json());
  assertContainerAllowed(p, body.container);

  if (!body.content && !body.url) {
    throw new MemweError("invalid_request", "one of `content` or `url` is required");
  }

  const raw = body.content ?? body.url ?? "";
  const contentHash = createHash("sha256").update(raw).digest();

  // withTenant, never pool.query: RLS is the isolation boundary, and a
  // WHERE clause you have to remember is not a boundary at all.
  const result = await withTenant({ orgId: p.orgId, container: body.container }, async (client) => {
    // Dedupe by content hash: duplicate content is never re-billed and
    // never re-processed. Returns the existing id synchronously.
    const existing = await client.query<{ id: string; status: string }>(
      `select id::text, status::text from documents
        where org_id=$1 and container=$2 and content_hash=$3`,
      [p.orgId, body.container, contentHash],
    );
    const found = existing.rows[0];
    if (found) return { id: found.id, status: found.status, deduped: true };

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
    return { id, status: "queued", deduped: false };
  });

  if (!result.deduped) {
    await enqueue({
      type: "document.accept",
      payload: { orgId: p.orgId, container: body.container, traceId, documentId: result.id },
      traceId,
      dedupeKey: `accept:${result.id}`,
    });
  }

  return c.json({ id: result.id, status: result.status, deduped: result.deduped }, 202);
});

documents.get("/:id", async (c) => {
  const p = c.get("principal");
  const rows = await withTenant({ orgId: p.orgId }, async (client) => {
    const r = await client.query(
      `select id::text, container, title, status::text, token_count, stage_error,
              created_at, updated_at
         from documents where id = $1`,
      [c.req.param("id")],
    );
    return r.rows;
  });
  const doc = rows[0];
  if (!doc) throw new MemweError("not_found", "document not found");
  return c.json(doc);
});

documents.get("/", async (c) => {
  const p = c.get("principal");
  const container = c.req.query("container");
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
  return c.json({ documents: rows });
});
