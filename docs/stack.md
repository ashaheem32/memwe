# The stack, and why

Every choice here is reversible, but some are far more expensive to reverse
than others. This records what we picked, what it beat, and what it costs —
so the next argument starts from the reasoning rather than from scratch.

Read with `docs/contracts.md` (the seam between the two tracks) and
`docs/sprint-0-checklist.md` (what is and isn't built).

---

## At a glance

| Layer | Choice | Version |
|---|---|---|
| Runtime | Node | ≥22 (local 25, CI 24) |
| Language | TypeScript, strict + project references | 5.9.3 |
| Package manager | pnpm workspaces | 10.33.0 |
| Database | PostgreSQL + pgvector | 17 / vector 0.8.6 |
| Queue | `jobs` table, `FOR UPDATE SKIP LOCKED` | — |
| HTTP | Hono + `@hono/node-server` | 4.13.5 |
| Validation & spec | Zod 4 + `@hono/zod-openapi` | 4.4.3 / 1.6.1 |
| Cache | Redis via ioredis | 7-alpine / 6.0.0 |
| Blobs | S3 API via AWS SDK v3 (MinIO local, R2 prod) | 3.1119.0 |
| PDF text + raster | mupdf (WASM) | 1.28.0 |
| OCR | tesseract.js (WASM) | 7.0.0 |
| Content sniffing | file-type | 22.0.2 |
| Token counting | gpt-tokenizer (o200k) | 4.0.0 |
| Lint + format | Biome | 2.5.10 |
| Tests | Vitest | 2.1.9 |
| Dev execution | tsx | 4.23.12 |
| Local stack | Docker Compose | — |

---

## The choices that matter

### PostgreSQL for everything — vectors, graph, queue

**Beat:** Pinecone / Weaviate / Qdrant for vectors, Neo4j for the graph, Redis
or SQS for the queue.

The argument is atomicity, not performance. Reconciliation writes a memory, an
edge, a version flip on the superseded row, and a `valid_to` — in one
transaction. Split the vectors into a separate service and that becomes a
distributed write with no rollback: the fact lands, the index doesn't, and now
current truth disagrees with what search returns. There is no clean way to fix
that after the fact.

Same argument for the queue. A job enqueued in Redis while the document row is
inserted in Postgres can diverge — the crash between the two leaves an
orphan either way. In-database, the job and the row it describes commit together.

Same for the graph: traversals here are one or two hops from a matched entity.
A recursive CTE does that in single-digit milliseconds. Neo4j earns its
operational cost at five-plus hops with complex path predicates, which this
workload never has.

**What it costs:** a single Postgres is a single scaling ceiling. Watch for it
at roughly 50M vectors in one tenant, or when HNSW index build time starts
blocking writes. The exit is a read-replica for search first, a dedicated
vector store second — not both at once.

**pgvector over pgvecto.rs / lantern:** it's the one every managed provider
supports and every benchmark tests against. Being boring here is the point.

### The queue is a table, not pgmq

**Beat:** pgmq, BullMQ, SQS.

pgmq is good and would have worked. It lost on two counts: it needs an
extension installed in every environment including CI, and its retry and
visibility semantics are its own rather than ours. A `jobs` table with
`FOR UPDATE SKIP LOCKED` is about 150 lines, fully inspectable with
`select * from jobs`, and lets us tune backoff, heartbeat and dead-lettering
directly — which we did, twice, in Sprint 0.

**What it costs:** polling. At `WORKER_POLL_MS=500` that's two queries per
worker per second doing nothing. Fine now; `LISTEN/NOTIFY` removes it when it
stops being fine.

It sits behind the `Queue` interface in `apps/worker/src/queue.ts`, so
swapping to pgmq or SQS later is one file and no call-site changes.

### Hono over Express / Fastify / Nest

Hono speaks Web-standard `Request`/`Response` and runs unchanged on Node, Bun,
Deno and Cloudflare Workers. That matters specifically because of the
voice-latency bet: getting recall under 50ms likely means running retrieval at
the edge, and with Hono that's a deployment target rather than a rewrite.

Fastify is faster on raw Node and has a better plugin ecosystem, but it's
Node-only. Express 5 is fine and universally understood, but its middleware
model is showing its age. Nest brings dependency injection and decorators that
two people don't need.

### Zod 4, and the spec derived from it

The OpenAPI document at `/openapi.json` is generated from the same schemas
that validate every request. There is no second source of truth to drift, and
in Sprint 5 the TS and Python SDKs, the docs site and the MCP tool definitions
all generate from it.

**Zod over TypeBox / Valibot / ArkType:** Zod is what the surrounding ecosystem
speaks — `@hono/zod-openapi`, the AI SDKs' tool schemas, most examples anyone
will copy. Valibot is meaningfully smaller and ArkType is faster, but neither
buys anything on a server where bundle size is irrelevant.

**Zod 4 specifically** because `@hono/zod-openapi@1` requires it, and because
v4's native `z.toJSONSchema` is what makes the spec fall out of the validators.

**The gotcha, already paid:** v4's `z.uuid()` enforces RFC 9562 version and
variant nibbles. Plenty of UUID-shaped values Postgres stores happily — our own
fixtures included — fail it. Identifiers here are opaque, so the contracts use
`z.guid()`. `tests/contracts.test.ts` locks that in.

### Raw SQL, no ORM

**Beat:** Prisma, Drizzle, Kysely.

Almost everything interesting in this schema is something an ORM fights:
hash-partitioned tables with composite primary keys, RLS driven by session
GUCs, `FOR UPDATE SKIP LOCKED`, `vector` columns and HNSW operators, recursive
CTEs for graph traversal, partial indexes. Every one of those ends in an ORM
escape hatch, and a codebase that's half ORM and half escape hatch is worse
than either.

**What it costs:** no types generated from the schema. Row shapes are declared
by hand at each query (`pool.query<{ id: string }>`), and nothing checks them
against the database. That's a real gap. If it bites, Kysely is the likeliest
answer — it's a query builder, not an ORM, and it wouldn't fight the schema.

### Biome over ESLint + Prettier

One binary, one config, one pass. Two people cannot afford a five-package lint
setup plus a formatter that argues with it.

`noFloatingPromises` is enabled — it needs type inference, which is why lint
takes ~1.5s instead of ~40ms. Worth it: the worker is full of deliberate
fire-and-forget, and the rule is what keeps "deliberate" honest.

**What it costs:** a smaller rule ecosystem than ESLint, and type-aware linting
is newer and narrower. If we ever need a rule Biome doesn't have, that's the
moment to reconsider — not before.

### pnpm over npm / yarn

pnpm's strict `node_modules` refuses to resolve a package that isn't a declared
dependency. That caught two real phantom dependencies during Sprint 0 (`zod`
missing from `@memwe/api`, then from the root test scope) which npm would have
resolved silently and broken in CI.

**No Nx or Turborepo yet.** Six packages, two people, and `tsc -b` project
references already give incremental builds. Add one when build time hurts.

### Redis as a cache that degrades

The auth cache falls back to an in-process map if Redis is unreachable, and
logs once. Losing a cache should cost latency, not availability — an API that
can't authenticate because a cache is down is a worse outage than a slow one.

It exists mainly for *revocation*: a revoked key must stop working everywhere
at once, not after each instance's TTL happens to lapse. Sprint 1 adds the
query-embedding cache and per-key rate limits, both of which need shared state.

**ioredis over node-redis:** better cluster and sentinel support for later, and
a more ergonomic API now. Either would do.

### S3 API, not the MinIO SDK

Local is MinIO, production is Cloudflare R2, and R2 speaks S3 — so one client
and an endpoint swap. **R2 for production because egress is free**, and
reprocessing re-reads every original repeatedly; S3 egress on that access
pattern is a real line item.

Uploads are presigned PUTs, so a 50MB file goes browser → storage directly and
never occupies an API worker for the duration of a transfer.

---

### mupdf for PDFs, tesseract.js for OCR

**Beat:** pdfjs-dist or unpdf for text, plus a native canvas binding for
rasterisation; poppler or a system tesseract binary.

mupdf does text extraction *and* page rendering, so the OCR fallback needs
one dependency rather than a PDF reader plus a canvas. Its structured-text
output also carries per-line bounding boxes and font sizes, which is what
makes both the fine-grained span map and heading inference possible — pdfjs
gives you text items and leaves you to reconstruct lines.

Everything is WASM, so there is no system binary to install in CI or a
container. That was the constraint that ruled out poppler and a native
tesseract, both of which are faster.

**tesseract.js specifically** because it needs no model API key. A vision
model reads messy scans far better and slots in behind `OcrProvider`, but
introducing a metered dependency into the default ingest path while the
spend cap is unset would be the wrong default.

**What it costs:** tesseract downloads ~15MB of language data on first use,
which is why the real OCR pass is opt-in in tests (`RUN_OCR_TESTS=1`) rather
than run on every CI job.

### A real tokenizer, not chars/4

Chunk budgets need token counts, and the number that matters belongs to the
embedding model — which is not chosen yet. So counting sits behind a
`TokenCounter` interface with o200k as the stand-in.

The heuristic was measured before being rejected:

| | real | chars/4 | error |
|---|---|---|---|
| English prose | 18 | 20 | +11% |
| Arabic | 12 | 12 | 0% |
| Code | 21 | 13 | **-38%** |
| Emoji | 18 | 5 | **-72%** |

Being 11% out on a 600-token budget is fine. Being 72% out is how a chunk
sails past an embedding model's hard limit and the request fails. The
corpus has Arabic, Devanagari and emoji fixtures precisely because that is
where a chars-based guess falls apart.

**What it costs:** ~25MB unpacked and a ~70ms load, paid once at worker
start rather than per chunk. When embeddings land, the provider's own count
replaces o200k here and the budget re-tunes against it.

## Deliberate omissions

| Not using | Why not, yet |
|---|---|
| An ORM | See above. Kysely if row-type drift starts biting. |
| Nx / Turborepo | Six packages. `tsc -b` is enough. |
| GraphQL | The API is a handful of REST endpoints that SDKs generate from. |
| Kubernetes | Two containers. Compose locally, a container host in production. |
| A DI framework | Module imports are dependency injection for a codebase this size. |
| An observability vendor | Structured logs with trace ids. Add OTel when there's more than one service to correlate. |
| `pgvectorscale` | Not needed until HNSW build times hurt. Roughly 50M vectors in. |

---

## Version drift — as of 29 Aug 2026

Nothing here is breaking anything. Listed so it's a decision, not a surprise.

| Package | Installed | Latest | Recommendation |
|---|---|---|---|
| `vitest` | 2.1.9 | 4.1.11 | **Bump.** Two majors behind, low blast radius — it's test-only. |
| `@types/node` | 22.20.1 | 26.4.0 | **Bump to ^24** to match CI. Types older than the runtime hide real APIs. |
| `@hono/node-server` | 1.19.17 | 2.1.1 | **Bump**, with a smoke run. One major, small surface. |
| `typescript` | 5.9.3 | 7.0.2 | **Wait.** TS 7 is the native port — a large performance win and a large ecosystem risk. Trial it on a branch; don't take it mid-sprint. |
| `zod` | 4.4.3 | 4.5.2 | Routine minor. |
| `@biomejs/biome` | 2.5.10 | 2.5.11 | Routine patch. Pin exactly — a formatter that changes underneath you reformats the repo. |
| `@aws-sdk/client-s3` | 3.1119.0 | 3.1121.0 | Routine. Releases daily; don't chase it. |

**Also worth cleaning:** `uuid-ossp` is enabled but redundant — `gen_random_uuid()`
has been core since PostgreSQL 13. One line in a future migration.

---

## Where this stack is most likely to change

1. **Retrieval moves to the edge** if the voice-latency bet gets picked up.
   Hono already runs there; Postgres does not. That's a read-replica or a
   session-resident cache problem, not a framework problem.
2. **The vector index leaves Postgres** if a single tenant gets large enough
   that HNSW build time blocks writes. Read-replica first.
3. **Kysely appears** if hand-declared row types start drifting from the schema.

Everything else on this page should still be true a year from now. If it
isn't, update this file in the same PR that changes it.
