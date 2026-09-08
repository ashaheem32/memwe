import { createHash, randomUUID } from "node:crypto";
import { close, pool, tx } from "./index.js";

/**
 * Seed fixtures. Two orgs so every isolation test has a second tenant to
 * prove it cannot see. Twenty documents including deliberately awkward
 * ones — keep every file that ever broke the pipeline in here.
 */
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

const DOCS: Array<{ org: string; container: string; title: string; body: string }> = [
  {
    org: ORG_A,
    container: "user_shaheem",
    title: "Onboarding notes",
    body: "Shaheem runs a DOOH advertising business. Prefers terse answers with no preamble.",
  },
  {
    org: ORG_A,
    container: "user_shaheem",
    title: "Stack decision",
    body: "We picked Postgres with pgvector over a dedicated vector database because one transaction covers chunks, memories and edges.",
  },
  {
    org: ORG_A,
    container: "user_shaheem",
    title: "Meeting 2026-08-14",
    body: "Discussed the memory layer. Bru takes the platform track, Shaheem takes the engine.",
  },
  { org: ORG_A, container: "user_shaheem", title: "Empty-ish doc", body: "ok" },
  {
    org: ORG_A,
    container: "project_memwe",
    title: "Latency budget",
    body: "Base recall must stay under 65ms p50. Reranking adds about 90ms and is optional per request.",
  },
  {
    org: ORG_A,
    container: "project_memwe",
    title: "Cost model",
    body: "Distillation dominates. Batch reconciliation per unit, never per candidate fact.",
  },
  {
    org: ORG_B,
    container: "user_other",
    title: "Should never leak",
    body: "This belongs to org B. If it ever appears in an org A search, the isolation test failed.",
  },
];

/** Fixed dev key so both machines and the smoke test agree. Never ship this. */
const DEV_KEY = "mw_dev_shaheem_0000000000000000000000000000";

/**
 * The near-cap file is generated rather than committed — 900KB of lorem in
 * git is 900KB in every clone, forever, to test one boundary condition.
 */
async function writeLargeFixture(): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
  await mkdir(dir, { recursive: true });
  const para =
    "Retrieval is four retrievers racing, one fusion, and a token budget. " +
    "Everything is parallel; the slowest leg sets the latency. ";
  await writeFile(join(dir, "large.txt"), para.repeat(7000).slice(0, 900_000), "utf8");
}

async function main(): Promise<void> {
  await writeLargeFixture();
  await tx(async (c) => {
    await c.query(
      `insert into orgs (id, name, plan) values ($1,'Acme (dev)','pro'), ($2,'Other (dev)','free')
       on conflict (id) do nothing`,
      [ORG_A, ORG_B],
    );

    for (const d of DOCS) {
      const hash = createHash("sha256").update(d.body).digest();
      await c.query(
        `insert into documents (id, org_id, container, title, markdown, content_hash, mime, status)
         values ($1,$2,$3,$4,$5,$6,'text/markdown','queued')
         on conflict (org_id, container, content_hash) where duplicate_of is null
         do nothing`,
        [randomUUID(), d.org, d.container, d.title, d.body, hash],
      );
    }

    // Enqueue the seeded docs so a fresh clone shows a pipeline that ran,
    // not seven rows stuck at 'queued' looking like something is broken.
    await c.query(
      `insert into jobs (type, payload, trace_id, dedupe_key)
       select 'document.accept',
              jsonb_build_object('orgId', d.org_id, 'container', d.container,
                                 'traceId', 'seed', 'documentId', d.id, 'revision', d.revision),
              'seed', 'document.accept:' || d.id::text || ':' || d.revision::text
         from documents d
        where d.status = 'queued'
       on conflict do nothing`,
    );

    await c.query(
      `insert into api_keys (org_id, name, prefix, hash)
       values ($1, 'dev', $2, $3)
       on conflict (prefix) where revoked_at is null do nothing`,
      [ORG_A, DEV_KEY.slice(0, 11), createHash("sha256").update(DEV_KEY).digest()],
    );
  });

  const { rows } = await pool.query<{ container: string; n: string }>(
    "select container, count(*)::text as n from documents group by container order by container",
  );
  console.log("  seeded:");
  for (const r of rows) console.log(`    ${r.container.padEnd(18)} ${r.n} docs`);
  console.log(`\n  dev API key: ${DEV_KEY}`);
  console.log(`  org A: ${ORG_A}   org B: ${ORG_B}\n`);
  await close();
}

main().catch((err: unknown) => {
  console.error("seed failed:", err);
  process.exitCode = 1;
  void close();
});
