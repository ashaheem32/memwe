# Sprint 0 — completion checklist

Audited against the repo, not the plan. **All six code gaps closed.**
Five external items remain — none of them can be done from a terminal.

---

## Code — complete

- [x] **Monorepo** — pnpm workspaces, 6 packages (`contracts`, `db`, `cache`, `storage`, `worker`, `api`)
- [x] **TypeScript strict** — plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`
- [x] **Lint** — Biome, `noExplicitAny` / `noConsole` / `useConst` as errors, `pnpm lint` in CI
- [x] **Format** — Biome, 100 cols, `.editorconfig` so both machines agree before the formatter runs
- [x] **CI on every PR** — lint → typecheck → migrate → seed → test, green from an empty database
- [x] **Postgres 17 + pgvector**
- [x] **Redis** — shared auth cache with in-process fallback; a Redis outage costs latency, not availability
- [x] **MinIO** — bucket created on `compose up`, presigned uploads, verified with a real PUT
- [x] **Seed fixtures** — 7 documents + an awkward-file corpus (see `packages/db/fixtures/README.md`)
- [x] **Migration tooling** — checksum guard refuses to re-run an edited migration
- [x] **The complete schema** — 18 tables, both clocks, `source_spans`, hash partitions, partial HNSW
- [x] **Orgs**
- [x] **API keys** — sha256 hashed, prefix-indexed, container-scopeable, revocable everywhere at once
- [x] **Container tag validation** — app regex + Postgres domain + a test asserting they agree
- [x] **RLS policies** — enforcing, via two roles (see below)
- [x] **Queue + worker runner** — retries, backoff with jitter, dead-letter, reaper, graceful drain
- [x] **OpenAPI skeleton** — OpenAPI 3.1 at `/openapi.json`, generated from the same Zod schemas that
      validate every request, with 8 named components so generated SDKs get real types
- [x] **Structured logging + trace ids**
- [x] **Error taxonomy** — `retryable` drives the runner's backoff-vs-dead-letter decision
- [x] **`docs/contracts.md`**

**Verification:** 16 tests, clean lint, clean `tsc -b`, and a 16-check smoke run
covering health, OpenAPI, auth, ingest, dedupe, a real upload through object
storage, and pipeline completion — all replayed against a database built from zero.

---

## Three bugs the work surfaced

**1. RLS was decorative.** Postgres does not apply row level security to a
table's owner, and both services connected as the owner. `tests/isolation.test.ts`
read another org's documents and passed. Fixed in `003_rls_role.sql` with two
roles — `memwe` (owner, bypasses RLS, for migrations and workers) and `memwe_app`
(`FORCE ROW LEVEL SECURITY`, one policy). **Request handlers use `withTenant()`,
never `pool.query`.**

**2. zod 4's `z.uuid()` rejected our own identifiers.** Upgrading to zod 4 (needed
by `@hono/zod-openapi`) brought RFC 9562 strictness: the version and variant
nibbles are enforced, so `11111111-1111-1111-1111-111111111111` fails. Postgres
stores it happily. Identifiers here are opaque, so the contracts use `z.guid()`.
Locked in by `tests/contracts.test.ts` — if someone "tidies" it back, that fails.

**3. The OpenAPI document had no components.** Every shape was inlined, which
would have produced SDKs full of anonymous types. Fixed with `.meta({ id })` on
each schema — plain zod 4, so `packages/contracts` stays framework-agnostic.

---

## External — needs a human

### A. Hard spend cap on model API keys  🔑  **BLOCKING SPRINT 1**
`MODEL_MONTHLY_BUDGET_USD` in `.env.example` is a placeholder, **not an
enforcement mechanism**. Anthropic Console → Billing → monthly spend limit.
Use a separate key for this project so its usage is legible, and alert at 50%,
not 90%.

Sprint 1 adds contextual chunk headers — one model call per document. A backfill
test against a real corpus is exactly how a month's budget disappears in an
afternoon.

### B. Sign the eight agreements  🔑  8 of 8 unsigned
`docs/contracts.md` has `AGREED: ______` under each. Items 1–6 have a proposed
answer already in code. This is a conversation with Bru, and the one thing in
Sprint 0 that genuinely cannot be automated.

### C. Add Bru as a collaborator  🔑
`github.com/ashaheem32/memwe` → Settings → Collaborators. He cannot open a PR yet.

### D. Branch protection on `main`  🔑
Settings → Rules → require a PR, require the `ci` check, no direct pushes. The
PR rules in `docs/contracts.md` are currently honour-system.

### E. Move off exFAT  🔑  recommended, not blocking
`/Volumes/Lexar` is exFAT: macOS scatters `._*` sidecars (filtered in four places
now — git, the migration runner, Biome, vitest) and permission bits do not
survive, so executable flags will not round-trip through git.

---

## Deferred to Sprint 1, deliberately

- **Real extraction.** `document.extract` is still a stub that only advances the
  state machine. Uploaded files land in object storage and are marked done
  without being read — that is the next thing to build.
- **A scanned, image-only PDF fixture.** The OCR path is a different code path
  and the corpus does not exercise it yet. Needs a real-world file.

Sprint 0 closes when A–D are done.
