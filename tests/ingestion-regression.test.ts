import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type Job, MemweError } from "@memwe/contracts";
import { close, pool, withTenant } from "@memwe/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  scope: null as string | null,
  blobs: new Map<string, Buffer>(),
}));
vi.mock("../apps/api/src/auth.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../apps/api/src/auth.js")>();
  return {
    ...original,
    authenticate: async () => ({
      orgId: "11111111-1111-1111-1111-111111111111",
      keyId: "test",
      containerScope: state.scope,
    }),
  };
});
vi.mock("@memwe/storage", () => ({
  blobKey: (org: string, id: string) => `org/${org}/doc/${id}`,
  presignedPut: async (key: string) => key,
  getObject: async (key: string) => {
    const bytes = state.blobs.get(key);
    if (!bytes) throw new Error("missing blob");
    return bytes;
  },
  objectExists: async (key: string) => state.blobs.has(key),
  copyObject: async (from: string, to: string) => {
    state.blobs.set(to, Buffer.from(state.blobs.get(from)!));
  },
  putObject: async (key: string, body: Buffer | string) => {
    state.blobs.set(key, Buffer.from(body));
  },
}));

import { app } from "../apps/api/src/app.js";
import { warmTokenizer } from "../apps/worker/src/chunk/tokens.js";
import { resetContextProvider } from "../apps/worker/src/context/index.js";
import { provider, resetProvider } from "../apps/worker/src/embed/index.js";
import { logger } from "../apps/worker/src/log.js";
import { queue } from "../apps/worker/src/queue.js";
import { Runner } from "../apps/worker/src/runner.js";
import { chunkStage, inputHash } from "../apps/worker/src/stages/chunk.js";
import { contextualizeStage } from "../apps/worker/src/stages/contextualize.js";
import { embedStage } from "../apps/worker/src/stages/embed.js";
import { documentTx, StaleJobError } from "../apps/worker/src/stages/guard.js";
import { fakeAnthropic, requestedOrds } from "./helpers/anthropic.js";

const ORG = "11111111-1111-1111-1111-111111111111",
  CONTAINER = "test_ingestion";
const ctx = { log: logger({ svc: "regression" }) };
const runner = new Runner();
const post = (body: unknown, path = "/v1/documents") =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const ingest = async (content: string, customId?: string, container = CONTAINER) => {
  const r = await post({ container, content, ...(customId ? { customId } : {}) });
  expect(r.status).toBe(202);
  return r.json() as Promise<{ id: string; revision: number; deduped: boolean; status: string }>;
};
async function claimFor(id: string, type?: string): Promise<Job | undefined> {
  const r = await pool.query(
    `update jobs set status='running',attempts=attempts+1,locked_by='test-worker',heartbeat_at=now()
    where id=(select id from jobs where payload->>'documentId'=$1 and status='pending'
      and ($2::text is null or type=$2) order by id limit 1)
    returning id::text,type,payload,attempts,max_attempts,trace_id`,
    [id, type ?? null],
  );
  const row = r.rows[0];
  return row
    ? {
        id: row.id,
        type: row.type,
        payload: row.payload,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        traceId: row.trace_id,
        lockedBy: "test-worker",
      }
    : undefined;
}
async function finish(id: string) {
  for (let i = 0; i < 10; i++) {
    const j = await claimFor(id);
    if (!j) break;
    await runner.run(j);
  }
  const r = await pool.query("select * from documents where id=$1", [id]);
  expect(r.rows[0]?.status).toBe("done");
  return r.rows[0];
}
async function clean() {
  await pool.query("delete from jobs where starts_with(payload->>'container',$1)", [CONTAINER]);
  await pool.query("delete from chunks where starts_with(container,$1)", [CONTAINER]);
  await pool.query("delete from documents where starts_with(container,$1)", [CONTAINER]);
}
beforeAll(warmTokenizer);
beforeEach(async () => {
  state.scope = null;
  state.blobs.clear();
  vi.stubEnv("EMBED_PROVIDER", "hash");
  vi.stubEnv("CONTEXT_PROVIDER", "none");
  resetProvider();
  resetContextProvider();
  await clean();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetProvider();
  resetContextProvider();
});
/** Route the worker's Anthropic client at the fake and make the provider pick it up. */
function withContextModel(reply?: Parameters<typeof fakeAnthropic>[0]) {
  const fake = fakeAnthropic(reply);
  vi.stubGlobal("fetch", fake.fetch);
  vi.stubEnv("CONTEXT_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
  resetContextProvider();
  return fake;
}
const chunkRows = (id: string) =>
  pool.query<{
    ord: number;
    text: string;
    context_header: string | null;
    generated_context: string | null;
    context_model: string | null;
    embedding_input_hash: Buffer;
    embedding: unknown;
  }>(
    "select ord,text,context_header,generated_context,context_model,embedding_input_hash,embedding from chunks where document_id=$1 order by ord",
    [id],
  );
afterAll(async () => {
  await clean();
  await close();
});

describe("HTTP ingestion and revision safety", () => {
  it("dedupes concurrent identical requests atomically", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ingest("concurrent exact bytes")),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.deduped)).toHaveLength(1);
  });
  it("preserves both customIds when content matches, including after a revision", async () => {
    const a = await ingest("old content", "A");
    const b = await ingest("new content", "B");
    await finish(b.id);
    const revised = await ingest("new content", "A");
    expect(revised.id).toBe(a.id);
    expect(revised.revision).toBe(2);
    const alias = await finish(a.id);
    expect(alias.markdown).toBe("new content");
    await ingest("third content", "B");
    await finish(b.id);
    const stable = await pool.query("select markdown from documents where id=$1", [a.id]);
    expect(stable.rows[0].markdown).toBe("new content");
  });
  it("prevents a job from writing after a revision arrives", async () => {
    const a = await ingest("version one", "rev");
    const old = await claimFor(a.id);
    const revised = await ingest("version two", "rev");
    expect(revised.revision).toBe(2);
    await expect(
      documentTx(old!, async (c) => {
        await c.query("update documents set markdown='stale' where id=$1", [a.id]);
      }),
    ).rejects.toBeInstanceOf(StaleJobError);
    await runner.run(old!);
    expect((await finish(a.id)).markdown).toBe("version two");
  });
  it("hides other containers from scoped keys on reads and completion", async () => {
    const own = await ingest("own", "own", `${CONTAINER}_allowed`);
    const other = await ingest("other", "other", `${CONTAINER}_private`);
    state.scope = `${CONTAINER}_allowed`;
    expect((await app.request(`/v1/documents/${own.id}`)).status).toBe(200);
    expect((await app.request(`/v1/documents/${other.id}`)).status).toBe(404);
    expect((await post({}, `/v1/documents/upload/${other.id}/complete`)).status).toBe(404);
    const listed = await (await app.request("/v1/documents")).json();
    expect(listed.documents.map((d: { id: string }) => d.id)).toEqual([own.id]);
  });
  it("makes upload completion revision-aware and seals its bytes", async () => {
    const first = await (
      await post(
        { container: CONTAINER, customId: "file", filename: "f.txt", contentType: "text/plain" },
        "/v1/documents/upload",
      )
    ).json();
    state.blobs.set(first.uploadUrl, Buffer.from("first"));
    const second = await (
      await post(
        { container: CONTAINER, customId: "file", filename: "f.txt", contentType: "text/plain" },
        "/v1/documents/upload",
      )
    ).json();
    expect(second.id).toBe(first.id);
    expect(second.revision).toBe(2);
    expect((await post({}, `/v1/documents/upload/${first.id}/complete?revision=1`)).status).toBe(
      409,
    );
    state.blobs.set(second.uploadUrl, Buffer.from("second"));
    expect((await post({}, `/v1/documents/upload/${second.id}/complete?revision=2`)).status).toBe(
      202,
    );
    state.blobs.set(second.uploadUrl, Buffer.from("late overwrite"));
    expect((await finish(second.id)).markdown).toBe("second");
  });
  it("banks successful embedding batches and resumes only missing vectors", async () => {
    const d = await ingest("placeholder");
    await pool.query("update documents set status='embedding' where id=$1", [d.id]);
    for (let ord = 0; ord < 3; ord++)
      await pool.query(
        `insert into chunks(document_id,org_id,container,revision,ord,text) values($1,$2,$3,1,$4,$5)`,
        [d.id, ORG, CONTAINER, ord, `chunk ${ord}`],
      );
    const model = provider();
    Object.defineProperty(model, "maxBatchSize", { value: 1, configurable: true });
    const embed = vi.spyOn(model, "embed");
    embed
      .mockResolvedValueOnce([new Array(1024).fill(0)])
      .mockRejectedValueOnce(new MemweError("invalid_request", "later batch fails"));
    const job: Job = {
      id: "0",
      type: "document.embed",
      payload: { orgId: ORG, container: CONTAINER, documentId: d.id, revision: 1, traceId: "t" },
      attempts: 1,
      maxAttempts: 5,
      traceId: "t",
    };
    await expect(embedStage(job, ctx)).rejects.toThrow("later batch");
    expect(
      (
        await pool.query(
          "select count(*)::int n from chunks where document_id=$1 and embedding is not null",
          [d.id],
        )
      ).rows[0].n,
    ).toBe(1);
    embed.mockClear();
    await embedStage(job, ctx);
    expect(embed).toHaveBeenCalledTimes(2);
  });
  it("invalidates vectors when context changes and hides stale revisions from app reads", async () => {
    const d = await ingest("body stays the same", "context");
    await finish(d.id);
    const revised = await post({
      container: CONTAINER,
      customId: "context",
      content: "body stays the same",
      title: "new title",
    });
    expect(revised.status).toBe(202);
    const visible = await withTenant({ orgId: ORG, container: CONTAINER }, (c) =>
      c.query("select id from chunks where document_id=$1", [d.id]),
    );
    expect(visible.rowCount).toBe(0);
    const j: Job = {
      id: "0",
      type: "document.chunk",
      payload: { orgId: ORG, container: CONTAINER, documentId: d.id, revision: 2, traceId: "t" },
      attempts: 1,
      maxAttempts: 5,
      traceId: "t",
    };
    await chunkStage(j, ctx);
    const chunks = await pool.query(
      "select embedding,context_header from chunks where document_id=$1",
      [d.id],
    );
    expect(chunks.rows.every((r) => r.embedding === null && r.context_header === "new title")).toBe(
      true,
    );
  });
  it("rolls back completion if the next enqueue fails", async () => {
    const d = await ingest("handoff");
    const job = await claimFor(d.id);
    vi.spyOn(queue, "enqueue").mockRejectedValueOnce(new Error("handoff failed"));
    await runner.run(job!);
    const r = await pool.query("select status from jobs where id=$1", [job!.id]);
    expect(r.rows[0].status).toBe("pending");
    expect(
      (
        await pool.query(
          "select count(*)::int n from jobs where payload->>'documentId'=$1 and type='document.extract'",
          [d.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("does not allow an old lease to complete, heartbeat, or fail its replacement", async () => {
    const d = await ingest("lease");
    const old = await claimFor(d.id);
    await pool.query("update jobs set heartbeat_at=now()-interval '1 hour' where id=$1", [old!.id]);
    await queue.reap(1000);
    const replacement = await claimFor(d.id);
    expect(replacement!.attempts).toBe(old!.attempts + 1);
    expect(await queue.complete(old!)).toBe(false);
    expect(await queue.kill(old!, "late")).toBe(false);
    await queue.retry(old!, "late", 0);
    await queue.heartbeat([old!]);
    await expect(documentTx(old!, async () => {})).rejects.toBeInstanceOf(StaleJobError);
    expect(
      (await pool.query("select status from jobs where id=$1", [old!.id])).rows[0].status,
    ).toBe("running");
  });
  it("fails the document when the reaper exhausts its current job", async () => {
    const d = await ingest("exhaustion");
    const j = await claimFor(d.id);
    await pool.query(
      "update jobs set max_attempts=attempts,heartbeat_at=now()-interval '1 hour' where id=$1",
      [j!.id],
    );
    await queue.reap(1000);
    expect(
      (await pool.query("select status,failed_stage from documents where id=$1", [d.id])).rows[0],
    ).toMatchObject({ status: "failed", failed_stage: "document.accept" });
  });
});

describe("contextual chunk headers", () => {
  const body = (v: string) =>
    `# Guide\n\n## One\n\n${"First section sentence. ".repeat(40)}\n\n## Two\n\n${v} ${"Second section sentence. ".repeat(40)}`;

  it("writes a context per chunk in one pass and re-keys the embedding input", async () => {
    const fake = withContextModel();
    const d = await ingest(body("v1"), "ctx");
    const doc = await finish(d.id);
    expect(fake.calls).toHaveLength(1);
    const rows = (await chunkRows(d.id)).rows;
    expect(rows.length).toBeGreaterThan(1);
    expect(requestedOrds(fake.calls[0]!.body)).toEqual(rows.map((r) => r.ord));
    for (const r of rows) {
      expect(r.generated_context).toBe(`ctx ${r.ord}`);
      expect(r.context_model).toBe("claude-opus-5");
      expect(r.embedding_input_hash.toString("hex")).toBe(
        inputHash(r.text, r.context_header, r.generated_context),
      );
      expect(r.embedding).not.toBeNull();
    }
    expect(doc.metadata.context).toMatchObject({
      model: "claude-opus-5",
      chunks: rows.length,
      generated: rows.length,
      reused: 0,
      missing: 0,
      passes: 1,
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  });

  it("carries contexts across a revision and only sends the changed chunks", async () => {
    const fake = withContextModel();
    const d = await ingest(body("v1"), "carry");
    await finish(d.id);
    const before = (await chunkRows(d.id)).rows;
    await ingest(body("v2"), "carry");
    await finish(d.id);
    const after = (await chunkRows(d.id)).rows;
    expect(fake.calls).toHaveLength(2);
    const changed = after.filter((r) => r.text !== before[r.ord]?.text).map((r) => r.ord);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThan(after.length);
    expect(requestedOrds(fake.calls[1]!.body)).toEqual(changed);
    for (const r of after) {
      expect(r.generated_context).toBe(`ctx ${r.ord}`);
      expect(r.embedding).not.toBeNull();
    }
    const meta = (await pool.query("select metadata from documents where id=$1", [d.id])).rows[0]
      .metadata;
    expect(meta.context).toMatchObject({
      reused: after.length - changed.length,
      generated: changed.length,
    });
  });

  it("regenerates when the heading path changes even though the text did not", async () => {
    const fake = withContextModel();
    const d = await ingest(body("v1"), "path");
    await finish(d.id);
    const before = (await chunkRows(d.id)).rows;
    // Renaming the H1 changes the path of every later chunk but the text of only the first.
    await ingest(body("v1").replace("# Guide", "# Manual"), "path");
    await finish(d.id);
    const after = (await chunkRows(d.id)).rows;
    expect(after.filter((r, i) => r.text === before[i]?.text).length).toBe(after.length - 1);
    expect(fake.calls).toHaveLength(2);
    expect(requestedOrds(fake.calls[1]!.body)).toEqual(after.map((x) => x.ord));
    expect(after.every((x) => x.context_header?.startsWith("Manual"))).toBe(true);
  });

  it("persists each pass before the next request, so a retry resumes with the rest", async () => {
    let broken = true;
    const fake = withContextModel((reqBody) => {
      const ords = requestedOrds(reqBody);
      if (broken && ords.includes(1))
        return { status: 500, error: { type: "api_error", message: "flaky" } };
      return { contexts: ords.map((ord) => ({ ord, context: `ctx ${ord}` })) };
    });
    vi.stubEnv("CONTEXT_CHUNKS_PER_PASS", "1");
    resetContextProvider();
    const d = await ingest(
      `${body("v1")}\n\n## Three\n\n${"Third section sentence. ".repeat(40)}`,
      "resume",
    );
    for (const type of ["document.accept", "document.extract", "document.chunk"])
      await runner.run((await claimFor(d.id, type))!);
    const n = (await chunkRows(d.id)).rowCount ?? 0;
    expect(n).toBeGreaterThan(2);
    const job: Job = {
      id: "0",
      type: "document.contextualize",
      payload: { orgId: ORG, container: CONTAINER, documentId: d.id, revision: 1, traceId: "t" },
      attempts: 1,
      maxAttempts: 5,
      traceId: "t",
    };
    await expect(contextualizeStage(job, ctx)).rejects.toThrow(/flaky/);
    expect(
      (await chunkRows(d.id)).rows.filter((x) => x.generated_context).map((x) => x.ord),
    ).toEqual([0]);
    broken = false;
    const callsBefore = fake.calls.length;
    await contextualizeStage(job, ctx);
    expect(fake.calls.slice(callsBefore).map((c) => requestedOrds(c.body))).toEqual(
      Array.from({ length: n - 1 }, (_, i) => [i + 1]),
    );
    expect((await chunkRows(d.id)).rows.every((x) => x.generated_context === `ctx ${x.ord}`)).toBe(
      true,
    );
    // Multi-pass: the document prefix carries the cache breakpoint on every request.
    for (const c of fake.calls.slice(callsBefore)) {
      const block = (c.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!
        .content[0]!;
      expect(block.cache_control).toEqual({ type: "ephemeral" });
    }
  });

  it("skips the model for a document over the size limit and says so on the document", async () => {
    const fake = withContextModel();
    vi.stubEnv("CONTEXT_MAX_DOC_TOKENS", "50");
    resetContextProvider();
    const d = await ingest(body("v1"), "big");
    const doc = await finish(d.id);
    expect(fake.calls).toHaveLength(0);
    expect(doc.metadata.context).toMatchObject({
      skipped: expect.stringContaining("CONTEXT_MAX_DOC_TOKENS"),
    });
    expect((await chunkRows(d.id)).rows.every((x) => x.generated_context === null)).toBe(true);
  });

  it("leaves the heading path as the only context when no model is configured", async () => {
    const d = await ingest(body("v1"), "plain");
    const doc = await finish(d.id);
    const rows = (await chunkRows(d.id)).rows;
    expect(rows.every((x) => x.generated_context === null && x.context_header !== null)).toBe(true);
    expect(doc.metadata.context).toBeUndefined();
  });
});

describe("url ingestion", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const article = await readFile(join("packages", "db", "fixtures", "article.html"));
    const pdf = await readFile(join("packages", "db", "fixtures", "simple.pdf"));
    server = createServer((req, res) => {
      const send = (status: number, type: string, body: Buffer | string) => {
        res.writeHead(status, { "content-type": type });
        res.end(body);
      };
      if (req.url === "/article" || req.url === "/same")
        return send(200, "text/html; charset=utf-8", article);
      if (req.url === "/pdf") return send(200, "application/pdf", pdf);
      return send(404, "text/plain", "no");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    vi.stubEnv("URL_ALLOW_PRIVATE", "true");
    vi.stubEnv("URL_FETCH_MODE", "http");
  });
  const doc = async (id: string) =>
    (await pool.query("select * from documents where id=$1", [id])).rows[0];

  it("rejects what it would never fetch, and content together with url, at the API", async () => {
    vi.stubEnv("URL_ALLOW_PRIVATE", "false");
    for (const body of [
      { container: CONTAINER, url: `${base}/article` },
      { container: CONTAINER, url: "http://169.254.169.254/latest/meta-data/" },
      { container: CONTAINER, url: "file:///etc/passwd" },
      { container: CONTAINER, url: "https://example.com/", content: "both" },
      { container: CONTAINER },
    ]) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(
      (await pool.query("select count(*)::int n from documents where container=$1", [CONTAINER]))
        .rows[0].n,
    ).toBe(0);
  });

  it("fetches, snapshots, extracts the article, and dedupes the same address", async () => {
    const r = await post({ container: CONTAINER, url: `${base}/article` });
    expect(r.status).toBe(202);
    const first = (await r.json()) as { id: string; status: string; deduped: boolean };
    expect(first).toMatchObject({ status: "queued", deduped: false });
    const row = await finish(first.id);
    expect(row.source).toBe("url");
    expect(row.source_uri).toBe(`${base}/article`);
    expect(row.mime).toBe("text/html");
    expect(row.blob_key).toMatch(new RegExp(`^org/${ORG}/doc/${first.id}/1/fetch/`));
    expect(state.blobs.get(row.blob_key)?.toString()).toContain("<title>Why Postgres");
    expect(row.title).toBe("Why Postgres Row Locks Are Enough");
    expect(row.markdown).toMatch(/^# Why Postgres Row Locks Are Enough\n\n/);
    expect(row.markdown).not.toContain("Pricing");
    expect(row.metadata.fetch).toMatchObject({
      status: 200,
      via: "http",
      contentType: "text/html",
      charset: "utf-8",
      redirects: 0,
      finalUrl: `${base}/article`,
    });
    expect(row.metadata.extraction).toMatchObject({ format: "html", readable: true });
    expect(row.token_count).toBeGreaterThan(100);
    // The same address again is the same document.
    const again = (await (await post({ container: CONTAINER, url: `${base}/article` })).json()) as {
      id: string;
      deduped: boolean;
    };
    expect(again).toMatchObject({ id: first.id, deduped: true });
    // With a customId it is a revision: fetched again under a new snapshot.
    const named = (await (
      await post({ container: CONTAINER, url: `${base}/article`, customId: "page" })
    ).json()) as { id: string };
    expect(named.id).not.toBe(first.id);
    await finish(named.id);
    const revised = (await (
      await post({ container: CONTAINER, url: `${base}/article`, customId: "page" })
    ).json()) as {
      id: string;
      revision: number;
      revised: boolean;
    };
    expect(revised).toMatchObject({ id: named.id, revision: 2, revised: true });
    const after = await finish(named.id);
    expect(after.blob_key).toMatch(/\/2\/fetch\//);
    expect(after.revision).toBe(2);
  });

  it("dedupes identical content fetched from a different address by hash", async () => {
    const a = (await (await post({ container: CONTAINER, url: `${base}/article` })).json()) as {
      id: string;
    };
    await finish(a.id);
    const b = (await (await post({ container: CONTAINER, url: `${base}/same` })).json()) as {
      id: string;
    };
    expect(b.id).not.toBe(a.id);
    const row = await finish(b.id);
    expect(row.duplicate_of).toBe(a.id);
    expect(row.metadata.extraction.reusedFrom).toBe(a.id);
    expect(row.markdown).toMatch(/^# Why Postgres/);
  });

  it("sends a URL that answers with a PDF through the PDF extractor", async () => {
    const r = (await (await post({ container: CONTAINER, url: `${base}/pdf` })).json()) as {
      id: string;
    };
    const row = await finish(r.id);
    expect(row.mime).toBe("application/pdf");
    expect(row.metadata.fetch.contentType).toBe("application/pdf");
    expect(row.metadata.extraction.format).toBe("pdf");
    expect(row.token_count).toBeGreaterThan(0);
  });

  it("fails the document, with the reason, when the address does not answer", async () => {
    const r = (await (await post({ container: CONTAINER, url: `${base}/gone` })).json()) as {
      id: string;
    };
    for (let i = 0; i < 10; i++) {
      const j = await claimFor(r.id);
      if (!j) break;
      await runner.run(j);
    }
    const row = await doc(r.id);
    expect(row.status).toBe("failed");
    expect(row.failed_stage).toBe("document.extract");
    expect(row.stage_error).toMatch(/404/);
    expect(row.blob_key).toBeNull();
  });
});
