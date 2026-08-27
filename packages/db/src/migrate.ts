import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { close, pool, tx } from "./index.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function ensureTable(): Promise<void> {
  await pool.query(`
    create table if not exists schema_migrations (
      name       text primary key,
      checksum   text not null,
      applied_at timestamptz not null default now()
    )`);
}

async function main(): Promise<void> {
  await ensureTable();

  // `._*` are macOS AppleDouble sidecars — this repo lives on exFAT, which
  // has no resource forks, so the Finder writes them as real files.
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql") && !f.startsWith("._"))
    .sort();
  const { rows } = await pool.query<{ name: string; checksum: string }>(
    "select name, checksum from schema_migrations",
  );
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));

  let ran = 0;
  for (const name of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 16);
    const prev = applied.get(name);

    if (prev !== undefined) {
      // An applied migration that changed on disk means someone edited
      // history. Fail loudly — this is exactly the "two signatures" rule.
      if (prev !== checksum) {
        throw new Error(
          `migration ${name} was modified after being applied (${prev} -> ${checksum}). ` +
            `Migrations are append-only. Write a new one.`,
        );
      }
      continue;
    }

    process.stdout.write(`  applying ${name} ... `);
    await tx(async (c) => {
      await c.query(sql);
      await c.query("insert into schema_migrations (name, checksum) values ($1, $2)", [
        name,
        checksum,
      ]);
    });
    process.stdout.write("ok\n");
    ran++;
  }

  console.log(ran === 0 ? "  up to date" : `  ${ran} migration(s) applied`);
  await close();
}

main().catch((err: unknown) => {
  console.error("\nmigration failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
  void close();
});
