import { createHash, randomUUID } from "node:crypto";
import { close, pool } from "@memwe/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const ORG = "11111111-1111-1111-1111-111111111111";
const CONTAINER = "test_dedupe";
const hash = (s: string) => createHash("sha256").update(s).digest();

async function insertDoc(opts: { content: string; customId?: string; duplicateOf?: string }) {
  const id = randomUUID();
  await pool.query(
    `insert into documents (id, org_id, container, custom_id, markdown, content_hash, duplicate_of, status)
     values ($1,$2,$3,$4,$5,$6,$7,'queued')`,
    [
      id,
      ORG,
      CONTAINER,
      opts.customId ?? null,
      opts.content,
      hash(opts.content),
      opts.duplicateOf ?? null,
    ],
  );
  return id;
}

beforeEach(async () => {
  await pool.query("delete from documents where container = $1", [CONTAINER]);
});
afterAll(async () => {
  await pool.query("delete from documents where container = $1", [CONTAINER]);
  await close();
});

describe("content-hash dedupe", () => {
  it("refuses a second document with identical content", async () => {
    await insertDoc({ content: "the same bytes" });
    await expect(insertDoc({ content: "the same bytes" })).rejects.toThrow(/duplicate key/i);
  });

  it("scopes uniqueness to the container, not the org", async () => {
    // Two users may legitimately hold the same document.
    await insertDoc({ content: "shared doc" });
    const id = randomUUID();
    await expect(
      pool.query(
        `insert into documents (id, org_id, container, markdown, content_hash, status)
         values ($1,$2,'test_dedupe_other',$3,$4,'queued')`,
        [id, ORG, "shared doc", hash("shared doc")],
      ),
    ).resolves.toBeTruthy();
    await pool.query("delete from documents where container = 'test_dedupe_other'");
  });

  it("lets a row marked as a duplicate share the original's hash", async () => {
    // A duplicate upload keeps its id — the caller holds it and deserves an
    // answer — so it has to sit outside the uniqueness constraint.
    const original = await insertDoc({ content: "uploaded twice" });
    await expect(
      insertDoc({ content: "uploaded twice", duplicateOf: original }),
    ).resolves.toBeTruthy();
  });

  it("still refuses two originals once a duplicate exists", async () => {
    const original = await insertDoc({ content: "x" });
    await insertDoc({ content: "x", duplicateOf: original });
    await expect(insertDoc({ content: "x" })).rejects.toThrow(/duplicate key/i);
  });
});

describe("customId", () => {
  it("is unique within a container", async () => {
    await insertDoc({ content: "a", customId: "same-id" });
    await expect(insertDoc({ content: "b", customId: "same-id" })).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it("does not constrain documents that have none", async () => {
    await insertDoc({ content: "a" });
    await expect(insertDoc({ content: "b" })).resolves.toBeTruthy();
  });
});

describe("chunk carry-over across a revision", () => {
  /** The statement the chunk stage runs: snapshot, delete, re-insert with reuse. */
  async function rechunk(documentId: string, texts: string[]) {
    const rows = texts.map((text, ord) => ({
      ord,
      text,
      text_hash: createHash("sha256").update(text).digest("hex"),
    }));
    const r = await pool.query<{ reused: boolean }>(
      `with old as (
         select distinct on (text_hash) text_hash, embedding, embed_model, embed_dim, embedded_at
           from chunks
          where document_id = $1 and container = $2
            and embedding is not null and text_hash is not null
       ),
       del as (delete from chunks where document_id = $1 and container = $2)
       insert into chunks (document_id, org_id, container, ord, text, text_hash,
                           embedding, embed_model, embed_dim, embedded_at)
       select $1, $3, $2, (v->>'ord')::int, v->>'text', decode(v->>'text_hash','hex'),
              o.embedding, o.embed_model, o.embed_dim, o.embedded_at
         from jsonb_array_elements($4::jsonb) as v
         left join old o on o.text_hash = decode(v->>'text_hash','hex')
       returning (embedding is not null) as reused`,
      [documentId, CONTAINER, ORG, JSON.stringify(rows)],
    );
    return r.rows.filter((x) => x.reused).length;
  }

  const vector = (seed: number) =>
    `[${Array.from({ length: 1024 }, (_, i) => ((i + seed) % 7) / 7).join(",")}]`;

  it("keeps the vector of every chunk whose text did not change", async () => {
    const id = await insertDoc({ content: "doc" });
    await rechunk(id, ["alpha", "bravo", "charlie"]);
    await pool.query(
      `update chunks set embedding = $2::vector, embed_model = 'test', embed_dim = 1024,
                         embedded_at = now() - interval '1 hour'
        where document_id = $1`,
      [id, vector(1)],
    );

    // One paragraph edited; the other two are untouched.
    const reused = await rechunk(id, ["alpha", "BRAVO REWRITTEN", "charlie"]);
    expect(reused).toBe(2);

    const { rows } = await pool.query<{ text: string; has: boolean }>(
      `select text, embedding is not null as has from chunks where document_id=$1 order by ord`,
      [id],
    );
    expect(rows.map((r) => r.has)).toEqual([true, false, true]);
  });

  it("carries embedded_at across too, so reuse stays visible", async () => {
    // Stamping now() on a carried-over vector destroys the only record that
    // it was reused, and makes the column a lie.
    const id = await insertDoc({ content: "doc2" });
    await rechunk(id, ["one", "two"]);
    await pool.query(
      `update chunks set embedding=$2::vector, embed_model='test', embed_dim=1024,
                         embedded_at = timestamptz '2020-01-01 00:00:00Z'
        where document_id=$1`,
      [id, vector(2)],
    );
    await rechunk(id, ["one", "two changed"]);
    const { rows } = await pool.query<{ embedded_at: Date | null }>(
      `select embedded_at from chunks where document_id=$1 order by ord`,
      [id],
    );
    expect(rows[0]?.embedded_at?.getUTCFullYear()).toBe(2020);
    expect(rows[1]?.embedded_at).toBeNull();
  });

  it("reuses nothing when every chunk changed", async () => {
    const id = await insertDoc({ content: "doc3" });
    await rechunk(id, ["p", "q"]);
    await pool.query(
      `update chunks set embedding=$2::vector, embed_model='test', embed_dim=1024, embedded_at=now()
        where document_id=$1`,
      [id, vector(3)],
    );
    expect(await rechunk(id, ["totally", "different"])).toBe(0);
  });

  it("handles a document whose chunks were never embedded", async () => {
    const id = await insertDoc({ content: "doc4" });
    await rechunk(id, ["a"]);
    expect(await rechunk(id, ["a"])).toBe(0);
  });

  it("does not multiply rows when a document repeats a chunk", async () => {
    // Two identical chunks share a text_hash; a naive join would fan out.
    const id = await insertDoc({ content: "doc5" });
    await rechunk(id, ["repeated", "repeated", "unique"]);
    await pool.query(
      `update chunks set embedding=$2::vector, embed_model='test', embed_dim=1024, embedded_at=now()
        where document_id=$1`,
      [id, vector(4)],
    );
    await rechunk(id, ["repeated", "repeated", "unique"]);
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text n from chunks where document_id=$1`,
      [id],
    );
    expect(Number(rows[0]!.n)).toBe(3);
  });
});
