/**
 * Sprint 0 milestone check, end to end. Requires the stack up, plus
 * `pnpm dev:api` and `pnpm dev:worker` running.
 */
import { readFile } from "node:fs/promises";

const API = process.env.API ?? "http://localhost:8080";
const KEY = process.env.DEV_KEY ?? "mw_dev_shaheem_0000000000000000000000000000";
const H = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

let failed = 0;
const fail = (m) => {
  console.error(`  ✗ ${m}`);
  failed++;
};
const ok = (m) => console.log(`  ✓ ${m}`);

const poll = async (id, want = "done", tries = 40) => {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const d = await fetch(`${API}/v1/documents/${id}`, { headers: H }).then((r) => r.json());
    if (d.status === want || d.status === "failed") return d.status;
  }
  return "timeout";
};

// ---- health -----------------------------------------------------------
const health = await fetch(`${API}/healthz`)
  .then((r) => r.json())
  .catch(() => null);
if (!health?.ok) {
  fail("api not healthy — is `pnpm dev:api` running?");
  process.exit(1);
}
ok("api healthy");
health.postgres ? ok("postgres reachable") : fail("postgres unreachable");
health.redis
  ? ok("redis reachable (shared cache active)")
  : fail("redis unreachable — auth cache is degraded to in-process");

// ---- openapi ----------------------------------------------------------
const spec = await fetch(`${API}/openapi.json`)
  .then((r) => r.json())
  .catch(() => null);
if (!spec) fail("no /openapi.json");
else {
  const paths = Object.keys(spec.paths ?? {});
  const want = ["/v1/documents", "/v1/documents/{id}", "/v1/documents/upload"];
  const missing = want.filter((p) => !paths.includes(p));
  spec.openapi?.startsWith("3.1")
    ? ok(`openapi ${spec.openapi} served, ${paths.length} paths`)
    : fail(`unexpected openapi version ${spec.openapi}`);
  missing.length === 0
    ? ok("spec covers ingest, read and upload")
    : fail(`spec missing: ${missing.join(", ")}`);
  spec.components?.schemas && Object.keys(spec.components.schemas).length > 0
    ? ok("request/response schemas derived from zod")
    : fail("spec has no component schemas — not derived from the contracts");
}

// ---- auth -------------------------------------------------------------
const unauth = await fetch(`${API}/v1/documents`, { headers: { authorization: "Bearer nope" } });
unauth.status === 401 ? ok("bad key rejected (401)") : fail(`bad key returned ${unauth.status}`);

// ---- ingest + dedupe --------------------------------------------------
const body = { container: "user_shaheem", title: "Smoke", content: `smoke ${Date.now()}` };
const res = await fetch(`${API}/v1/documents`, {
  method: "POST",
  headers: H,
  body: JSON.stringify(body),
});
if (res.status !== 202) {
  fail(`ingest returned ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const { id } = await res.json();
ok(`ingested ${id} (202)`);

const dupe = await fetch(`${API}/v1/documents`, {
  method: "POST",
  headers: H,
  body: JSON.stringify(body),
}).then((r) => r.json());
dupe.deduped === true && dupe.id === id
  ? ok("re-ingest deduped to the same id")
  : fail("dedupe failed");

(await poll(id)) === "done"
  ? ok("worker drove it to done")
  : fail("pipeline did not complete — is `pnpm dev:worker` running?");

// ---- upload through MinIO --------------------------------------------
const pdf = await readFile(new URL("../packages/db/fixtures/simple.pdf", import.meta.url));
const up = await fetch(`${API}/v1/documents/upload`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    container: "user_shaheem",
    filename: "simple.pdf",
    contentType: "application/pdf",
  }),
});
if (up.status !== 200) fail(`presign returned ${up.status}: ${await up.text()}`);
else {
  const { id: upId, uploadUrl } = await up.json();
  ok("presigned upload URL issued");

  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/pdf" },
    body: pdf,
  });
  put.ok
    ? ok(`${pdf.length}B PUT straight to object storage (${put.status})`)
    : fail(`PUT failed ${put.status}`);

  // Completing without a real object must be refused, so the API never
  // takes the client's word that the upload happened.
  const bogus = await fetch(`${API}/v1/documents/upload/${crypto.randomUUID()}/complete`, {
    method: "POST",
    headers: H,
  });
  bogus.status === 404
    ? ok("complete on an unknown id rejected (404)")
    : fail(`bogus complete returned ${bogus.status}`);

  const done = await fetch(`${API}/v1/documents/upload/${upId}/complete`, {
    method: "POST",
    headers: H,
  });
  done.status === 202
    ? ok("upload completed and queued (202)")
    : fail(`complete returned ${done.status}: ${await done.text()}`);

  (await poll(upId)) === "done"
    ? ok("uploaded file drove to done")
    : fail("uploaded document did not complete");
}

// ---- extraction -------------------------------------------------------
const extractCases = [
  { file: "simple.pdf", ct: "application/pdf", want: /Latency budget/i, label: "PDF text layer" },
  { file: "structured.md", ct: "text/markdown", want: /Sub-300ms/i, label: "markdown" },
  {
    file: "unicode.txt",
    ct: "text/plain",
    want: /\u0645\u0631\u062d\u0628\u0627/,
    label: "unicode text",
  },
];
for (const c of extractCases) {
  const bytes = await readFile(new URL(`../packages/db/fixtures/${c.file}`, import.meta.url));
  const pre = await fetch(`${API}/v1/documents/upload`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ container: "user_shaheem", filename: c.file, contentType: c.ct }),
  });
  if (!pre.ok) {
    fail(`${c.label}: presign ${pre.status}`);
    continue;
  }
  const { id: eid, uploadUrl: eurl } = await pre.json();
  await fetch(eurl, { method: "PUT", headers: { "content-type": c.ct }, body: bytes });
  await fetch(`${API}/v1/documents/upload/${eid}/complete`, { method: "POST", headers: H });
  const st = await poll(eid);
  if (st !== "done") {
    fail(`${c.label}: ended at '${st}'`);
    continue;
  }
  const doc = await fetch(`${API}/v1/documents/${eid}`, { headers: H }).then((r) => r.json());
  doc.token_count > 0
    ? ok(`${c.label} extracted (${doc.token_count} tokens)`)
    : fail(`${c.label}: no tokens`);
}

// A lying extension must fail the document, not the batch, and not retry.
{
  const bytes = await readFile(
    new URL("../packages/db/fixtures/actually-a-png.txt", import.meta.url),
  );
  const pre = await fetch(`${API}/v1/documents/upload`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      container: "user_shaheem",
      filename: "actually-a-png.txt",
      contentType: "text/plain",
    }),
  });
  const { id: bid, uploadUrl: burl } = await pre.json();
  await fetch(burl, { method: "PUT", headers: { "content-type": "text/plain" }, body: bytes });
  await fetch(`${API}/v1/documents/upload/${bid}/complete`, { method: "POST", headers: H });
  const st = await poll(bid, "failed");
  const doc = await fetch(`${API}/v1/documents/${bid}`, { headers: H }).then((r) => r.json());
  st === "failed" && /image\/png/.test(doc.stage_error ?? "")
    ? ok("lying extension failed the document with a reason")
    : fail(`lying extension ended '${st}' (${doc.stage_error ?? "no error"})`);
}

// ---- validation -------------------------------------------------------
const bad = await fetch(`${API}/v1/documents`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ container: "bad container!", content: "x" }),
});
bad.status === 400
  ? ok("invalid container rejected (400)")
  : fail(`bad container returned ${bad.status}`);

process.exitCode = failed ? 1 : 0;
console.log(failed ? `\n  SMOKE FAILED (${failed})\n` : "\n  SPRINT 0 MILESTONE: PASS\n");
