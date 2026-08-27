import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgres://memwe:memwe@localhost:5432/memwe";
const deadline = Date.now() + 60_000;

process.stdout.write("  waiting for postgres ");
for (;;) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query("select 1");
    await client.end();
    process.stdout.write(" up\n");
    break;
  } catch {
    await client.end().catch(() => {});
    if (Date.now() > deadline) {
      process.stdout.write("\n  postgres did not come up in 60s. Is `docker compose up -d` running?\n");
      process.exit(1);
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 1000));
  }
}
