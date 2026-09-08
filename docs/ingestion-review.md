# Ingestion review — 2026-09-08

The six requested capabilities have implementations, but this milestone is not ready for sign-off. This review changes no application code.

## Status — resolved 2026-09-08

Fixes 1–9 below are implemented in the same change set as this document,
with migration `007_ingestion_guards.sql`. Regression coverage lives in
`tests/ingestion-regression.test.ts` (scoped reads, concurrent ingest,
revision fencing, transactional handoff, lease fencing, reaper failure,
banked embedding batches, context-change invalidation),
`tests/provenance-regression.test.ts` (offset units, rewritten spans,
chunk budgets and source ranges), and `tests/embed-http.test.ts` (provider
request serialization). Verified on the local stack: `pnpm verify` passes
(148 tests, lint warnings only), `RUN_OCR_TESTS=1` passes, and `pnpm smoke`
passes end to end against the running API and worker. README documents the
offset units, revision identity, partial extraction, and the meaning of
`done`. Gate item 5 (`document.index`) is the next milestone and is not
started.

## Validation

- `pnpm lint`: passes with 1 warning and 27 informational diagnostics.
- `pnpm typecheck`: passes.
- `pnpm test`: 90 passed, 35 failed, 1 skipped. The database suites encounter connection errors; after rerunning outside the sandbox, PostgreSQL refuses connections on localhost:5432. These failures are not evidence that their assertions fail.
- Docker's local socket does not exist, so the database stack is not available.
- Migrations, seed, full `pnpm verify`, and the end-to-end smoke test remain unverified.
- Real OCR is opt-in (`RUN_OCR_TESTS=1`) and was skipped. No paid embedding requests were made.
- Additional local reproductions confirmed incorrect ligature offsets, UTF-16 rejection through extraction, and chunk ceiling violations.

## Required fixes, in priority order

### 1. Enforce container scope on read and upload completion (high)

`apps/api/src/routes/documents.ts`: GET by ID, list, and upload completion use only the organization in `withTenant`, without `assertContainerAllowed`. The database policy in migration 003 enforces organization isolation, not API-key container scope. A scoped key can therefore read other containers in its own organization and complete their uploads.

Apply the key's scope to these paths and test same-organization, different-container access. This is a platform-track fix.

### 2. Fence jobs and derived data by document revision (high)

`apps/api/src/routes/documents.ts:102`, `apps/worker/src/runner.ts:97`, and the stage writes: a revision changes the same document row while old jobs can still run. Payloads and dedupe keys contain no revision. Status transition failure does not prevent a stage from running. An old extraction can overwrite new markdown; an old embedding job can finish the revised document. An existing live accept job can also suppress the new revision's enqueue.

Include revision in jobs and dedupe keys, condition writes and advancement on it, and keep stale chunks unavailable until the new revision is ready. Existing chunks remain after the revision update despite the comment about clearing derived data. Preserve reusable vectors separately or identify their revision explicitly.

### 3. Make pipeline handoffs atomic and fence queue leases (high)

`apps/worker/src/runner.ts:101`: job completion commits before the next job is enqueued or the document becomes done. A crash between these operations permanently strands the document. API ingestion similarly commits its document before enqueueing.

Commit each handoff in one database transaction, or use a transactional outbox. In `apps/worker/src/queue.ts`, completion, heartbeat, retry, and kill must check lease ownership/generation; currently they operate by job ID alone, so an old worker can change its replacement's job. Reaping an exhausted job to dead must also mark the document failed; it currently leaves the document mid-pipeline.

### 4. Make content dedupe and customId revisions race-safe (high)

`apps/api/src/routes/documents.ts:68` and `apps/worker/src/stages/extract.ts`: dedupe uses separate lookup and insert/update operations. Concurrent identical ingests can hit an unhandled uniqueness violation; concurrent identical uploads can cause one extraction to fail. Lock or atomically resolve conflicts and return the canonical document.

Resolve customId identity before deciding the hash response: if A is revised to content already belonging to B, the current code returns B without revising A. New customIds submitted with existing content are not retained. Define an alias/canonical-content policy that preserves the intended customId behavior. `/upload` also accepts customId but has no revision path for an existing value. Clear `duplicate_of` when a duplicate document becomes an independent revision, and store the real hash on duplicate uploads.

### 5. Correct source-span semantics (high)

`apps/worker/src/extract/normalize.ts`, `spans.ts:119`, `pdf.ts:254`, and `packages/contracts/src/normalized-doc.ts` disagree about precision and units.

Reproduction: source `ﬁsh after` becomes `fish after`. Resolving `after` reports source `[5,10)` with `exact: true`; the source range in JavaScript character units is `[4,9)`. A line-start map cannot interpolate accurately after within-line expansion or removal. The contract says byte offsets, but the implementation counts UTF-16 code units.

Choose explicit coordinate units; map edits precisely or provide enclosing source ranges with `exact: false`. PDF heading prefixes and de-hyphenated continuations need equivalent handling. A PDF continuation currently gets no new segment, losing its page when a word crosses pages. OCR geometry is represented by a zero box while resolution still claims exactness. The resolver must also honor map truncation instead of extrapolating beyond it.

### 6. Enforce chunk budgets and preserve provenance (high)

`apps/worker/src/chunk/index.ts`: chunking 1,000 repetitions of `A short sentence. ` with defaults produces token counts `[808,880,880,880,840]`, exceeding the configured hard maximum of 810. Oversized pieces consume the ceiling before overlap is added. Separators and synthesized fence delimiters also need budget allowance.

Include carry and formatting in the final token check. Chunk spans exclude carried text; oversized splitting reconstructs whitespace and fences while incrementing offsets by reconstructed lengths. Track source ranges for each piece and overlap, distinguishing synthetic text. Test long sentences, code, Unicode, and overlap provenance.

Chunking reparses markdown instead of consuming `doc.sections`. Consolidate the structural parser or honor the normalized section contract. A budget flush immediately before a heading can leak overlap across sections, and folding a tiny final section into the previous chunk does not update its heading path.

### 7. Reuse embeddings by the complete input (high)

`apps/worker/src/stages/chunk.ts:58` hashes only chunk text, but `stages/embed.ts:43` embeds context header plus text. Changing the title or moving unchanged text under a different heading can reuse an obsolete vector.

Key reuse on the full embedding input and model/configuration identity. Test a title-only or heading-only change with unchanged body text.

### 8. Persist successful embedding batches and harden the HTTP adapter (medium)

`apps/worker/src/stages/embed.ts:47` awaits `embedAll`, which collects every provider batch in memory, before writing anything. If the final provider batch fails, earlier successful calls are lost and billed again on retry. Persist after each successful provider batch.

`apps/worker/src/embed/http.ts:50` sends `dimensions` for Voyage. Its documented parameter is `output_dimension`: https://docs.voyageai.com/reference/embeddings-api. Use provider-specific request serialization and a mocked HTTP contract test; the live rejection/ignore behavior was not tested.

Add request deadlines, validate response indexes and finite vector values, reject invalid configuration (for example a zero write-batch size), and enforce individual-input limits including headers. The current tokenizer is explicitly a stand-in, not a provider-accurate hard-limit validator.

### 9. Close extraction and OCR gaps (medium)

UTF-16 decoding exists, but extraction rejects a BOM-prefixed UTF-16LE `Hello world` as unsupported because binary sniffing happens before decoding. Detect supported encoding BOMs before rejecting NUL bytes. Source BOM accounting also assumes three bytes regardless of encoding.

`normalizeLine` strips trailing spaces from authored markdown, including two-space hard line breaks, and normalizes code contents. Define and test which transformations are acceptable inside code and authored markdown.

PDF running-header detection counts repeated edge positions rather than distinct pages and removes matching text anywhere on a page. Restrict removal to actual page edges with per-page counts. Surface PDF page limits and skipped OCR as persisted partial-extraction warnings; the current pipeline can report done for incomplete extraction.

`TesseractOcr.ready` can create multiple workers during concurrent first calls because it caches only after awaiting initialization. Cache the initialization promise and use a defined concurrency strategy. Exercise concurrent OCR, mixed scanned/digital PDFs, and page caps.

## Readiness gate and next phase

1. Fix high-priority identity, isolation, recovery, provenance, chunk-budget, and embedding-reuse defects.
2. Add regression tests for concurrent ingest/upload, revision during each stage, crash during handoff, stale lease writes, scoped-key reads, normalized spans, chunk limits, and partial embedding failure. Current dedupe tests mostly exercise database constraints and chunk reuse, not HTTP revision behavior; current status tests exercise helpers rather than runner recovery.
3. Run `pnpm verify` with PostgreSQL available, the opt-in OCR test, and an API-to-worker smoke test. Verify provider request/response contracts without spending money, then validate the configured real provider in the project's normal integration environment.
4. Update README: it still says extraction is a stub. Document offset units, revision identity, partial extraction, and the meaning of done.
5. Then implement `document.index`, which is the next unregistered stage in this repository. Agree its completion contract with the platform track, expose only the current document revision, and prove retrieval with source citations. The current pipeline deliberately skips indexing and marks done after embedding. Generated context headers and later distillation/reconciliation can build on the corrected contracts.
