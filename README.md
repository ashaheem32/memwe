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

pnpm dev:api     # terminal 1
pnpm dev:worker  # terminal 2
pnpm smoke       # terminal 3 — the Sprint 0 milestone check
```

`pnpm nuke` tears the stack down including volumes.

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

## What is deliberately not built yet

Real extraction. `apps/worker/src/stages/extract.ts` is a stub that only
advances the state machine — building a PDF parser before the runner is
trustworthy is the classic Sprint 0 trap. Sprint 1 replaces it.
