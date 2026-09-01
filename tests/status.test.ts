import { randomUUID } from "node:crypto";
import { close, pool, tx } from "@memwe/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  advanceStatus,
  allowedFrom,
  failDocument,
  isTerminal,
  reprocess,
  STAGE_STATUS,
  STATUS_ORDER,
} from "../apps/worker/src/status.js";

const ORG = "11111111-1111-1111-1111-111111111111";
const CONTAINER = "test_status";

async function makeDoc(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into documents (id, org_id, container, content_hash, status)
     values ($1, $2, $3, decode(md5(random()::text), 'hex'), 'queued')`,
    [id, ORG, CONTAINER],
  );
  return id;
}
const statusOf = async (id: string): Promise<string> => {
  const { rows } = await pool.query<{ status: string }>(
    "select status::text from documents where id = $1",
    [id],
  );
  return rows[0]?.status ?? "missing";
};

beforeEach(async () => {
  await pool.query("delete from documents where container = $1", [CONTAINER]);
});
afterAll(async () => {
  await pool.query("delete from documents where container = $1", [CONTAINER]);
  await close();
});

describe("transition table", () => {
  it("covers every stage in the pipeline", () => {
    // A stage with no status is a stage whose progress is invisible.
    for (const type of [
      "document.accept",
      "document.extract",
      "document.chunk",
      "document.embed",
      "document.index",
    ] as const) {
      expect(STAGE_STATUS[type]).toBeDefined();
    }
  });

  it("orders the states the pipeline actually runs in", () => {
    expect(STATUS_ORDER).toEqual([
      "queued",
      "extracting",
      "chunking",
      "embedding",
      "indexing",
      "done",
    ]);
  });

  it("allows a move only from strictly earlier states", () => {
    expect(allowedFrom("chunking")).toEqual(["queued", "extracting"]);
    expect(allowedFrom("queued")).toEqual([]);
  });

  it("allows failure from anywhere still live, but not from done", () => {
    expect(allowedFrom("failed")).toContain("queued");
    expect(allowedFrom("failed")).toContain("indexing");
    expect(allowedFrom("failed")).not.toContain("done");
  });

  it("knows which states are terminal", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("chunking")).toBe(false);
  });
});

describe("advanceStatus", () => {
  it("walks the whole pipeline", async () => {
    const id = await makeDoc();
    for (const next of ["extracting", "chunking", "embedding", "indexing", "done"] as const) {
      expect(await tx((c) => advanceStatus(c, id, next))).toBe(true);
      expect(await statusOf(id)).toBe(next);
    }
  });

  it("skips ahead when a stage is not registered", async () => {
    // embed marks done directly while document.index has no handler.
    const id = await makeDoc();
    await tx((c) => advanceStatus(c, id, "embedding"));
    expect(await tx((c) => advanceStatus(c, id, "done"))).toBe(true);
    expect(await statusOf(id)).toBe("done");
  });

  it("refuses to move backwards", async () => {
    // A retry that outlived its stage must not drag the document back —
    // this is the race the WHERE-clause guard exists for.
    const id = await makeDoc();
    await tx((c) => advanceStatus(c, id, "embedding"));
    expect(await tx((c) => advanceStatus(c, id, "extracting"))).toBe(false);
    expect(await statusOf(id)).toBe("embedding");
  });

  it("is a no-op when already in the target state", async () => {
    const id = await makeDoc();
    await tx((c) => advanceStatus(c, id, "chunking"));
    expect(await tx((c) => advanceStatus(c, id, "chunking"))).toBe(false);
    expect(await statusOf(id)).toBe("chunking");
  });

  it("cannot revive a finished document", async () => {
    const id = await makeDoc();
    await tx((c) => advanceStatus(c, id, "done"));
    expect(await tx((c) => advanceStatus(c, id, "chunking"))).toBe(false);
    expect(await statusOf(id)).toBe("done");
  });

  it("clears a stale error when moving forward again", async () => {
    const id = await makeDoc();
    await tx((c) => failDocument(c, id, "document.extract", "boom"));
    await tx((c) => reprocess(c, id));
    await tx((c) => advanceStatus(c, id, "extracting"));
    const { rows } = await pool.query<{ stage_error: string | null; failed_stage: string | null }>(
      "select stage_error, failed_stage from documents where id = $1",
      [id],
    );
    expect(rows[0]?.stage_error).toBeNull();
    expect(rows[0]?.failed_stage).toBeNull();
  });

  it("only one of two concurrent writers wins", async () => {
    const id = await makeDoc();
    const [a, b] = await Promise.all([
      tx((c) => advanceStatus(c, id, "chunking")),
      tx((c) => advanceStatus(c, id, "chunking")),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

describe("failDocument", () => {
  it("records the stage as well as the message", async () => {
    // Without the stage, a support question starts by grepping worker logs.
    const id = await makeDoc();
    await tx((c) => advanceStatus(c, id, "chunking"));
    expect(await tx((c) => failDocument(c, id, "document.chunk", "nothing to chunk"))).toBe(true);
    const { rows } = await pool.query<{
      status: string;
      failed_stage: string;
      stage_error: string;
    }>("select status::text, failed_stage, stage_error from documents where id = $1", [id]);
    expect(rows[0]).toMatchObject({
      status: "failed",
      failed_stage: "document.chunk",
      stage_error: "nothing to chunk",
    });
  });

  it("will not fail a document that already succeeded", async () => {
    const id = await makeDoc();
    await tx((c) => advanceStatus(c, id, "done"));
    expect(await tx((c) => failDocument(c, id, "document.embed", "late"))).toBe(false);
    expect(await statusOf(id)).toBe("done");
  });
});

describe("reprocess", () => {
  it("is the only way out of a terminal state", async () => {
    for (const terminal of ["done", "failed"] as const) {
      const id = await makeDoc();
      if (terminal === "done") await tx((c) => advanceStatus(c, id, "done"));
      else await tx((c) => failDocument(c, id, "document.extract", "x"));
      expect(await tx((c) => reprocess(c, id))).toBe(true);
      expect(await statusOf(id)).toBe("queued");
    }
  });

  it("leaves a document mid-pipeline alone", async () => {
    const id = await makeDoc();
    await tx((c) => advanceStatus(c, id, "chunking"));
    expect(await tx((c) => reprocess(c, id))).toBe(false);
    expect(await statusOf(id)).toBe("chunking");
  });
});
