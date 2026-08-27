/**
 * Sprint 0 milestone check, end to end:
 *   POST /v1/documents -> row written -> job enqueued -> worker runs it -> status done
 *
 * Requires: docker compose up, pnpm migrate, pnpm seed, and BOTH
 * `pnpm dev:api` and `pnpm dev:worker` running.
 */
const API = process.env.API ?? "http://localhost:8080";
const KEY = process.env.DEV_KEY ?? "mw_dev_shaheem_0000000000000000000000000000";
const H = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

const fail = (m) => { console.error(`  ✗ ${m}`); process.exitCode = 1; };
const ok = (m) => console.log(`  ✓ ${m}`);

const health = await fetch(`${API}/healthz`).then((r) => r.json()).catch(() => null);
if (!health?.ok) { fail("api not healthy — is `pnpm dev:api` running?"); process.exit(1); }
ok("api healthy");

const unauth = await fetch(`${API}/v1/documents`, { headers: { authorization: "Bearer nope" } });
unauth.status === 401 ? ok("bad key rejected (401)") : fail(`bad key returned ${unauth.status}`);

const body = { container: "user_shaheem", title: "Smoke test", content: `smoke ${Date.now()}` };
const res = await fetch(`${API}/v1/documents`, { method: "POST", headers: H, body: JSON.stringify(body) });
if (res.status !== 202) { fail(`ingest returned ${res.status}: ${await res.text()}`); process.exit(1); }
const { id } = await res.json();
ok(`ingested ${id} (202)`);

const dupe = await fetch(`${API}/v1/documents`, { method: "POST", headers: H, body: JSON.stringify(body) });
const d = await dupe.json();
d.deduped === true && d.id === id ? ok("re-ingest deduped to the same id") : fail("dedupe failed");

let status = "queued";
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250));
  const doc = await fetch(`${API}/v1/documents/${id}`, { headers: H }).then((r) => r.json());
  status = doc.status;
  if (status === "done" || status === "failed") break;
}
status === "done"
  ? ok("worker drove it to done")
  : fail(`stuck at '${status}' — is \`pnpm dev:worker\` running?`);

const bad = await fetch(`${API}/v1/documents`, {
  method: "POST", headers: H,
  body: JSON.stringify({ container: "bad container!", content: "x" }),
});
bad.status === 400 ? ok("invalid container rejected (400)") : fail(`bad container returned ${bad.status}`);

console.log(process.exitCode ? "\n  SMOKE FAILED\n" : "\n  SPRINT 0 MILESTONE: PASS\n");
