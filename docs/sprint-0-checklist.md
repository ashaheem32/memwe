# Sprint 0 — completion checklist

Audited against the repo at commit `0b108dc`, not from memory.

**14 of 20 items done. 6 gaps, 5 of which are code. 5 external items need a human.**

---

## Done

- [x] **Monorepo** — pnpm workspaces, 4 packages (`contracts`, `db`, `worker`, `api`)
- [x] **TypeScript strict** — plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Project references wired, `tsc -b` clean.
- [x] **CI on every PR** — `on: [push, pull_request]`, green on a from-scratch database
- [x] **Postgres 17 + pgvector** — `pgvector/pgvector:pg17`, healthchecked
- [x] **Migration tooling** — checksum guard refuses to re-run an edited migration, which is how the "two signatures" rule is enforced by the machine rather than by memory
- [x] **The complete schema** — 18 tables. Both clocks on `memories`, `source_spans`, hash partitions on `chunks`/`memories`, partial HNSW on `is_latest`, typed edges with real FKs into the partitioned table
- [x] **Orgs**
- [x] **API keys** — sha256 hashed, prefix-indexed, scopeable to a container prefix, `revoked_at` honoured
- [x] **Container tag validation** — regex in the app, `container_tag` domain in Postgres, and a test asserting the two agree
- [x] **RLS policies** — and actually enforcing, after `003` (see below)
- [x] **Queue + worker runner** — retries, exponential backoff with jitter, dead-letter, stale-job reaper, graceful drain, dedupe keys
- [x] **Structured logging + trace ids** — one `traceId` from HTTP request through every stage
- [x] **Error taxonomy** — `MemweError` with `retryable`, which is what the runner reads to choose backoff over dead-letter
- [x] **`docs/contracts.md` written** — all eight agreements documented

> The RLS item is worth re-reading. The policies in `001` were decorative —
> Postgres does not apply row level security to a table's owner, and both
> services connected as the owner. `tests/isolation.test.ts` caught it on
> day one and `003_rls_role.sql` fixed it with two roles. This is the only
> item on the list that was *wrong* rather than missing.

---

## Gaps — code

### 1. Lint  ❌  ·  owner: both  ·  ~20 min
No config, no script, not in CI. Nothing stops a `console.log` or a floating promise landing on `main`.

**Complete it with Biome** — one tool for lint *and* format, one config, fast enough that nobody disables it:

```bash
pnpm add -Dw @biomejs/biome
pnpm biome init
```

Then in `biome.json` turn on the rules that actually matter for this codebase:
`noFloatingPromises` (the worker is full of `void` fire-and-forget — those must be deliberate), `noExplicitAny`, `useAwait`, and `noConsoleLog` with an exception for `scripts/**` and `src/log.ts`.

Add to root `package.json`:
```json
"lint": "biome check .",
"lint:fix": "biome check --write ."
```
Add `- run: pnpm lint` to `.github/workflows/ci.yml` between `typecheck` and `migrate`.

**Why Biome over ESLint + Prettier:** two people cannot afford a five-package lint config and a separate formatter that disagree with each other. If you already have strong ESLint preferences, use them — but decide today, not in Sprint 3.

### 2. Format  ❌  ·  owner: both  ·  included above
Same tool. Add `.editorconfig` too so both machines agree before the formatter even runs. **Run `pnpm lint:fix` once, commit the whole-repo reformat as its own commit**, so that diff never pollutes a review.

### 3. OpenAPI skeleton  ❌  ·  owner: **Bru**  ·  ~2 hours
Nothing exists. This is the Sprint 0 item with the longest tail: in Sprint 5 the TS and Python SDKs, the docs site, and the MCP tool definitions are all supposed to be generated from it. Every week it doesn't exist is a week of hand-written drift.

**Do not hand-write YAML.** The request/response shapes are already Zod schemas in `packages/contracts`. Derive the spec from them so they cannot diverge:

```bash
pnpm --filter @memwe/api add @hono/zod-openapi
```

Replace `new Hono()` with `new OpenAPIHono()`, convert each route to
`createRoute({ method, path, request, responses })` referencing the existing
`IngestRequest` schema, and serve the document at `/openapi.json`.

Acceptance: `curl localhost:8080/openapi.json | jq '.paths | keys'` lists
`/v1/documents` and `/v1/documents/{id}`, and changing a Zod schema changes
the spec with no second edit.

### 4. Redis running but unwired  ⚠️  ·  owner: **Bru**  ·  ~1 hour
The container is up and healthy; `apps/api/src/auth.ts` uses an in-process
`Map` with a 30s TTL. That is *fine for Sprint 0* — but it means a second
API instance has a second cache, and nothing else can invalidate it.

**Minimum to close honestly:** either wire it, or delete the service from
`docker-compose.yml` until Sprint 1 needs it. A declared dependency nothing
uses is how a stack quietly grows things nobody can remove later.

**Recommendation: wire it now**, because Sprint 1 needs Redis anyway for the
query-embedding cache and per-key rate limits. `ioredis`, a `cache.ts` with
`get/set/del`, and move the API-key lookup behind it. Key revocation then
becomes a `DEL` instead of a 30-second wait.

### 5. MinIO running but unwired  ⚠️  ·  owner: **Shaheem**  ·  ~2 hours
Same problem, worse: the container is up, no bucket is created, no S3 client
exists, and `documents.blob_key` is never written. There is currently no way
to ingest a file — only text and URLs.

**Complete it:**
1. Add a `createbuckets` one-shot service to `docker-compose.yml` that runs
   `mc mb --ignore-existing local/memwe-blobs` so a fresh clone has the bucket.
2. `pnpm --filter @memwe/db add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`
   (S3 API, so R2 in production is a URL change).
3. `packages/db/src/blobs.ts` — `putObject`, `getObject`, `presignedPut`.
4. `POST /v1/documents/upload` returning a presigned PUT plus a document id;
   the worker reads `blob_key` in stage 02.

This is arguably Sprint 1 work — stage 02 is a stub, so nothing can read a
blob yet. **Decide explicitly** and write it down, rather than leaving it
ambiguous.

### 6. Seed fixtures thin  ⚠️  ·  owner: **Shaheem**  ·  ~30 min
7 documents, all short text. The plan said ~20 including deliberately awkward
ones, and the point of the corpus is that it accumulates every file that ever
broke the pipeline.

Add: a real multi-page PDF, a scanned/image-only PDF, a `.docx`, a UTF-8 file
with emoji and RTL text, a 900KB text file (near the 1MB cap), an empty file,
and a file whose extension lies about its content. **Most of these will fail
in Sprint 1 — that is what they are for.** Commit them under
`packages/db/fixtures/` and keep them small.

---

## External — needs a human, cannot be done from the terminal

### A. Hard spend cap on model API keys  🔑  **BLOCKING SPRINT 1**
`docs/contracts.md` item 7. `MODEL_MONTHLY_BUDGET_USD` in `.env.example` is a
placeholder, **not an enforcement mechanism**.

Go to the Anthropic Console → Billing → set a monthly spend limit, and create
a *separate* key for this project so its usage is legible. Set an alert at 50%,
not 90%.

Do this before the first extraction job runs in Sprint 1. Contextual chunk
headers make one model call per document; a backfill test against a real
corpus is exactly how a month's budget disappears in an afternoon.

### B. Sign the eight agreements  🔑  8 of 8 still unsigned
`docs/contracts.md` has `AGREED: ______` under each. Items 1–6 have a proposed
answer already in code — this is a conversation with Bru, not a task, and it is
the one thing in Sprint 0 that genuinely cannot be automated.

### C. Add Bru as a collaborator  🔑
`github.com/ashaheem32/memwe` → Settings → Collaborators.

### D. Branch protection on `main`  🔑
Settings → Rules → require a PR, require the `ci` check to pass, no direct
pushes. The PR rules in `docs/contracts.md` are currently honour-system.

### E. Move off exFAT  🔑  recommended, not blocking
`/Volumes/Lexar` is exFAT: macOS scatters `._*` sidecars (already filtered in
three places) and permission bits do not survive, so executable flags will not
round-trip through git. Move to an APFS volume before Sprint 1.

---

## Suggested order

| | Item | Owner | Why now |
|---|---|---|---|
| 1 | Spend cap (A) | Shaheem | Blocks Sprint 1. Five minutes. |
| 2 | Lint + format (1, 2) | both | Every day without it is a day of drift to reformat later |
| 3 | Sign agreements (B) | both | The conversation the whole sprint was for |
| 4 | Collaborator + branch protection (C, D) | Shaheem | Bru cannot open a PR yet |
| 5 | OpenAPI (3) | Bru | Longest tail — Sprint 5 depends on it |
| 6 | Redis (4) | Bru | Or delete the service and defer explicitly |
| 7 | MinIO (5), fixtures (6) | Shaheem | Fold into Sprint 1 if you'd rather |

Sprint 0 closes when 1–4 are done. 5–7 can trail into Sprint 1 **if written
down as a decision** rather than left ambiguous.
