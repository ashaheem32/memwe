# Contracts

The eight things Shaheem and Bru agree once, in one sitting, before either
writes feature code. Everything here is cheap now and expensive in Sprint 4.

Status: **scaffolded — items 1–6 have a proposed answer in code. Sit down
together, argue, and mark each one AGREED with a date.**

---

## 1. The schema — `packages/db/migrations/001_init.sql`
Every table the roadmap needs, including columns nothing reads until
Sprint 4/5. Specifically non-negotiable:

- `memories.valid_from / valid_to` (world time) **and** `recorded_at /
  invalidated_at` (system time). Four columns, not one `updated_at`.
- `memories.source_spans` and `documents.span_map`.

Both are nearly free now and a full reprocessing job later.

**Rule after this migration: additive changes only.** Never rename or drop
in the same migration that adds. The migration runner refuses to re-run a
file whose checksum changed, on purpose.

> AGREED: ______ (date)

## 2. `NormalizedDoc` — `packages/contracts/src/normalized-doc.ts`
Shaheem's output contract. Every extractor produces it; nothing downstream
knows Notion or Gmail exists. Adding a connector must never mean touching
chunking, embedding, or distillation.

> AGREED: ______ (date)

## 3. `retrieve()` — `packages/contracts/src/retrieve.ts`
Bru owns the implementation; Shaheem calls it from reconciliation to find a
candidate fact's neighbourhood. The two parameters that exist only for that
call: `subject` and `includeSuperseded`.

This is the **one** real coupling between the tracks. Everything else is
private to one side.

> AGREED: ______ (date)

## 4. Job envelope — `packages/contracts/src/jobs.ts`
One outer shape for every job: `{ orgId, container, traceId }` plus a
per-type payload. Retries, backoff and dead-lettering behave identically
for every job type because the envelope is identical.

> AGREED: ______ (date)

## 5. Errors and logs — `packages/contracts/src/errors.ts`, `apps/worker/src/log.ts`
Structured JSON logs. One `traceId` threaded from the HTTP request through
every worker stage. `MemweError.retryable` is what the runner reads to
choose between backoff and dead-letter.

> AGREED: ______ (date)

## 6. Local dev in one command
`pnpm up` → Postgres+pgvector, Redis, MinIO, migrations applied.
`pnpm seed` → two orgs, seven documents, one dev API key.

Non-negotiable, because it is what lets you work independently.

> AGREED: ______ (date)

## 7. Model access and budget  ⚠️ NOT DONE
Put a **hard monthly spend cap** on the API keys and set up a shared usage
dashboard. Do this before the first extraction job ever runs in Sprint 1,
not after the first surprise bill.

`MODEL_MONTHLY_BUDGET_USD` in `.env.example` is a placeholder, not an
enforcement mechanism. Set the real cap in the provider console.

> AGREED: ______ (date)

## 8. Definition of done
Merged, migration applied, integration test passing, **and demoable from
the seed data**. If it isn't demoable it isn't done.

> AGREED: ______ (date)

---

## Working agreements

- **Monday, 20 minutes.** What each of you is doing, and any schema change coming.
- **Friday, demo.** Working software from the seed data, to each other.
- **Migrations take two signatures.** Announce Monday, merge after both have read it.
- **PRs under 400 lines, reviewed within 4 hours.** If review would block
  you longer, merge behind a flag.
- **Ties break by domain.** Shaheem decides write-path, Bru decides read-path.
  Schema ties go to whoever maintains that table longer.
- **Never edit the other track's files.** Open a one-line issue and keep moving.

## Deliberate deviations from the plan

| Decision | Plan said | We did | Why |
|---|---|---|---|
| Queue | pgmq | `jobs` table + `FOR UPDATE SKIP LOCKED` | No extension to install, fully inspectable, retries/heartbeat/DLQ are ours to tune. Sits behind the `Queue` interface so swapping later is one file. |
| Partitions | hash by container | 4 partitions on `chunks` and `memories` | Enough to prove isolation at the storage layer. Raise the modulus before you have real data, not after. |
| FKs into partitioned tables | not specified | `memory_edges` carries `container` and FKs on `(container, id)` | Keeps referential integrity without an app-level invariant nobody remembers. |
| Status machine | each stage sets its own | the runner drives it, guarded in one module | See below. |
| Database roles | one role | `memwe` (owner, bypasses RLS) + `memwe_app` (RLS forced) | See below. |

### Migration 005 — three declared states that were never written

`doc_status` has declared seven states since `001`, but only three were ever
used: `accept` wrote `extracting`, then a stage wrote `done` or the runner
wrote `failed`. `chunking`, `embedding` and `indexing` sat in the enum
unused, so a document being embedded reported `extracting` — indistinguishable
from being stuck, which is the exact failure the dead-job handling exists to
avoid.

The cause was that each stage wrote its own status. The runner now owns both
the status machine and pipeline advancement; stages are pure work units.
That also removed the identical "enqueue next or mark done" block that three
stages were repeating.

Transitions go through `advanceStatus()`, which is forward-only and guarded
in the `WHERE` clause rather than by read-then-write — two workers can hold
jobs for the same document at once (a reaped job running beside its
replacement), and a conditional update makes the loser a no-op instead of a
rollback. `done` and `failed` are terminal; `reprocess()` is the only way out.

### Migration 003 — the bug the isolation test caught on day one

The RLS policies written in `001_init.sql` were **decorative**. Postgres does
not apply row level security to a table's owner, and both the API and the
worker connected as the owner. `tests/isolation.test.ts` read another org's
documents and the query returned them without complaint.

`003_rls_role.sql` fixes it with two roles, which is the right production
shape anyway:

- **`memwe`** — owner. Migrations, workers, metering. Legitimately cross-tenant.
- **`memwe_app`** — every request-scoped read, with `FORCE ROW LEVEL SECURITY`
  and exactly one policy.

The rule that follows: **request paths use `withTenant()`, never `pool.query`.**
If you are reaching for the owner pool inside a request handler, that is the bug.

Worth noticing that this is precisely the failure mode the plan warned about —
isolation that looks right, passes review, and enforces nothing. It cost twenty
minutes in Sprint 0. It would have cost a customer later.
