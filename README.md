# memwe

A memory layer for AI agents. Working codename **Mnema**.

**Sprint 0 — Foundations.** The skeleton: local stack, complete schema, job
queue, worker runner, and enough API to prove the pipeline end to end.

- Architecture: the `Mnema Architecture` doc
- Differentiation: `The Memory Wedge`
- Schedule and ownership: `Mnema Build Plan`
- **Start here:** [`docs/contracts.md`](docs/contracts.md)

## Who owns what

| Track | Owner | Lives in |
|---|---|---|
| Engine — extract, chunk, distill, reconcile | **Shaheem** | `apps/worker`, `packages/db/migrations` |
| Platform — API, recall, SDK, dashboard | **Bru** | `apps/api`, `packages/db/src` |
| Shared seam | both | `packages/contracts`, the schema |

If you're editing the other track's files, something is wrong.

## Run it

```bash
pnpm install
cp .env.example .env
pnpm up          # docker compose + wait + migrate
pnpm seed        # 2 orgs, 7 docs, 1 dev API key
pnpm --filter @memwe/worker exec playwright install chromium   # once; URL ingestion renders JS pages with it

pnpm dev:api     # terminal 1
pnpm dev:worker  # terminal 2
pnpm smoke       # terminal 3 — the Sprint 0 milestone check
```

`pnpm nuke` tears the stack down including volumes.

## Before you push

```bash
pnpm verify   # lint -> typecheck -> migrate -> seed -> test
```

This is exactly what `.github/workflows/ci.yml` runs, in the same order.
Running a subset of it locally and calling it "the gate" is how a migration
that broke `pnpm seed` reached `main` — `migrate` and `seed` are steps, not
setup.

## The milestone

`POST /v1/documents` writes a row, enqueues a job, a worker claims it and
drives it to `done` — authenticated, tenant-scoped, deduped, traced.

```bash
curl -s localhost:8080/v1/documents \
  -H "authorization: Bearer mw_dev_shaheem_0000000000000000000000000000" \
  -H "content-type: application/json" \
  -d '{"container":"user_shaheem","title":"Hello","content":"Shaheem prefers terse answers."}'
```

## Layout

```
packages/contracts   the seam — NormalizedDoc, job envelope, retrieve(), errors
packages/db          schema, migrations, pool, tenant transactions
apps/worker          queue, runner, reaper, pipeline stages      (Shaheem)
apps/api             auth, routes, error handling                (Bru)
```

## Environment note — this volume is exFAT

`/Volumes/Lexar` is exFAT, so macOS writes `._name` AppleDouble sidecars next
to real files. They are filtered in three places (`.gitignore`, the migration
runner, `vitest.config.ts`) because each one otherwise tries to parse them as
source. `find . -name "._*" -not -path "*/node_modules/*" -delete` clears them.

exFAT also has no permission bits, so executable flags and file modes will not
survive in git. If this project outlives Sprint 0, move it to an APFS volume.

## Ingestion semantics

These are the guarantees the pipeline makes today. `docs/ingestion-review.md`
records the defects that produced them.

**Identity and revisions.** A document is identified by `customId` within a
container. Re-ingesting a `customId` with different content (or a different
title or metadata) keeps the id and bumps `revision`; identical content is
deduped and returns `deduped: true` with no new work. A revision does not
rebuild the document: the chunk stage diffs the new chunks against the
current rows by text and heading path, keeps unchanged rows in place with
their ids, contexts and vectors, inserts what changed, deletes what went,
and records the counts under `metadata.diff` (returned as `diff` on the
document). Only the new rows reach the context and embedding stages, so a
one-paragraph edit costs one paragraph of model calls, and a citation of an
unchanged chunk survives the revision. Every job carries the
revision it was enqueued for, and a stage that finds a newer revision on the
row aborts without writing. Chunks are stored per revision and are readable
through the app role only when their revision is the document's current one
and the document is `done`. Presigned uploads follow the same rule: `/upload`
returns a `revision`, and `/upload/{id}/complete?revision=N` is refused with
409 when a newer upload has been requested. Completion copies the bytes to a
sealed key, so a PUT URL that is reused after completion cannot change what
the worker reads.

**Batches.** `POST /v1/documents/batch` takes up to 100 items of the single
ingest shape and answers per item, in order, with either a result or an
error. Items run one after another in their own transactions, so an item
that is refused does not undo the ones before it and two identical items
dedupe against each other. A malformed item is a 400 for the whole request.

**URLs.** `POST /v1/documents` with `url` instead of `content` creates a
document with no bytes; the extract stage fetches them once, keeps the
snapshot in blob storage under that revision, and from then on the document
behaves like an upload. Retries, reprocessing and dedupe read the snapshot,
never the site. The fetch is plain HTTP first; when the page is a JavaScript
shell, or `URL_FETCH_MODE=headless`, it is rendered in a headless Chromium
with images, media and fonts blocked. A URL that answers with a PDF or plain
text goes to that extractor. HTML goes through Readability to drop
navigation, banners and footers, then to a serializer that writes block
structure (headings, lists, code, tables, quotes) as markdown and nothing
inline, so every line still maps to a line of the page text exactly. Private,
loopback, link-local and cloud-metadata addresses are refused at the API and
again in the worker on every redirect hop and every request the browser
makes; `URL_ALLOW_PRIVATE=true` is for local development only. The same
address in a container is the same document unless a `customId` makes it a
revision; identical bytes from two addresses dedupe by hash. What the fetch
did is recorded under `metadata.fetch`.

**Handoffs.** A stage commits its writes, the status change, and the next job
in one transaction. Queue completion, heartbeat, retry, and kill are fenced by
the worker's lease; an old worker cannot act on its replacement's job. A job
the reaper exhausts marks the document `failed`.

**Offsets.** `NormalizedDoc.spanMap` offsets are UTF-16 code units into the
decoded source text (BOM included), or into the page text for PDFs, which
also carry `page`. For HTML the source is the page text: the readable text,
one block per line, derived deterministically from the stored snapshot. A resolved
`SourceLocation` reports `exact: false` when
normalization rewrote the range (ligatures, de-hyphenation, OCR), in which
case the offsets are the enclosing line rather than the exact characters. A
span map past its size limit is truncated, never extrapolated. Chunk rows
carry `source_ranges` so overlap and generated fence delimiters are
distinguishable from source text.

**Partial extraction.** A PDF over `PDF_MAX_PAGES` or with pages that needed
OCR but were skipped (OCR disabled, or past the OCR page cap) still completes, but `GET /v1/documents/{id}`
returns `extraction.partial: true` with `totalPages`, `pages`, and
`ocrSkipped` so the caller can see what is missing.

**Contextual chunk headers.** After chunking, `document.contextualize` asks
a model for a one-to-two sentence context per chunk: one request per
document, with the whole document first and every pending chunk after it,
answered in one structured response. A document with more chunks than
`CONTEXT_CHUNKS_PER_PASS` takes several passes, and then the document block
carries a prompt-cache breakpoint so later passes read it from cache. Each
pass is written before the next request, so a retry only sends what is
missing. A revision keeps a chunk's context when its text, heading path and
model are unchanged. Refusals and documents over `CONTEXT_MAX_DOC_TOKENS`
fall back to the heading path and are recorded under `metadata.context`
with the token usage. Without `ANTHROPIC_API_KEY` the stage is a no-op.
Whether the prefix really comes back from cache is asserted by
`tests/context-live.test.ts`, which spends a few cents and is opt-in:
`RUN_LIVE_MODEL_TESTS=1 pnpm test`. CI runs it whenever the
`ANTHROPIC_API_KEY` repository secret is set; fork PRs skip it.

**Embeddings.** The embedding input is the generated context, then the
heading path, then the chunk text. Vectors are reused only when that full
input and the model match. Each successful provider batch is written before
the next one is sent, so a failure part way through is not re-billed on
retry.

**What `done` means.** The current revision has markdown, chunks, and a
vector for every chunk. `document.index` is not registered yet; the runner
marks `done` after `document.embed`. Retrieval over `done` documents is the
next milestone.

## What is deliberately not built yet

`document.index`. It is the next unregistered stage in
`apps/worker/src/stages/index.ts`; its completion contract needs agreement
with the platform track before it exposes anything to `retrieve()`.
