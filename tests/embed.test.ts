import { MemweError } from "@memwe/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { warmTokenizer } from "../apps/worker/src/chunk/tokens.js";
import { HashEmbedding } from "../apps/worker/src/embed/hash.js";
import {
  EMBED_DIM,
  embedBatch,
  planBatches,
  provider,
  resetProvider,
} from "../apps/worker/src/embed/index.js";
import type { EmbeddingProvider, EmbedInput } from "../apps/worker/src/embed/provider.js";
import { assertDimensions } from "../apps/worker/src/embed/provider.js";
import { logger } from "../apps/worker/src/log.js";

const quiet = logger({ svc: "test" });
const inputs = (n: number, text = "a sentence of about ten tokens goes here now"): EmbedInput[] =>
  Array.from({ length: n }, () => ({ text, kind: "document" as const }));

beforeAll(async () => {
  await warmTokenizer();
});

afterEach(() => {
  resetProvider();
  for (const k of [
    "EMBED_PROVIDER",
    "VOYAGE_API_KEY",
    "OPENAI_API_KEY",
    "EMBED_API_KEY",
    "NODE_ENV",
    "EMBED_ALLOW_HASH",
  ]) {
    delete process.env[k];
  }
});

describe("provider selection", () => {
  it("never picks a metered provider without a key", () => {
    // The whole point: no ingest job may start spending money because a
    // default said so.
    const p = provider(quiet);
    expect(p.metered).toBe(false);
    expect(p.id).toBe("hash-v1");
  });

  it("picks voyage when its key is present", () => {
    process.env["VOYAGE_API_KEY"] = "test-key";
    const p = provider(quiet);
    expect(p.id).toContain("voyage");
    expect(p.metered).toBe(true);
  });

  it("errors rather than falling back when a provider is named without its key", () => {
    process.env["EMBED_PROVIDER"] = "voyage";
    expect(() => provider(quiet)).toThrow(/VOYAGE_API_KEY/);
  });

  it("refuses the non-semantic stand-in in production", () => {
    // A corpus embedded with hash vectors retrieves nothing useful, and
    // nothing about the pipeline would look broken.
    process.env["NODE_ENV"] = "production";
    expect(() => provider(quiet)).toThrow(/no embedding provider configured/);
  });

  it("allows it in production only when said so deliberately", () => {
    process.env["NODE_ENV"] = "production";
    process.env["EMBED_ALLOW_HASH"] = "true";
    expect(provider(quiet).id).toBe("hash-v1");
  });
});

describe("the hash stand-in", () => {
  const p = new HashEmbedding();

  it("produces unit vectors of the schema's dimension", async () => {
    const [v] = await p.embed(inputs(1));
    expect(v).toHaveLength(EMBED_DIM);
    const norm = Math.sqrt(v!.reduce((a, b) => a + b * b, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("is deterministic, so re-running the pipeline is a no-op", async () => {
    const [a] = await p.embed([{ text: "retrieval", kind: "document" }]);
    const [b] = await p.embed([{ text: "retrieval", kind: "document" }]);
    expect(a).toEqual(b);
  });

  it("puts identical text in the same place and different text elsewhere", async () => {
    const [same, other] = await p.embed([
      { text: "the recall path", kind: "document" },
      { text: "completely unrelated words", kind: "document" },
    ]);
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * (y[i] ?? 0), 0);
    expect(dot(same!, same!)).toBeCloseTo(1, 5);
    expect(Math.abs(dot(same!, other!))).toBeLessThan(0.5);
  });

  it("handles empty text without producing NaN", async () => {
    const [v] = await p.embed([{ text: "", kind: "document" }]);
    expect(v!.every(Number.isFinite)).toBe(true);
  });
});

describe("batch planning", () => {
  const caps = { maxBatchSize: 10, maxBatchTokens: 1_000_000 };

  it("respects the row cap", () => {
    expect(planBatches(inputs(25), caps).map((b) => b.length)).toEqual([10, 10, 5]);
  });

  it("respects the token cap even when the row count would fit", () => {
    // 128 chunks of 600 tokens is 77k — a provider capping a request at
    // 120k rejects a batch that merely counted rows.
    const batches = planBatches(inputs(20), { maxBatchSize: 1000, maxBatchTokens: 30 });
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((b) => b.length > 0)).toBe(true);
  });

  it("never drops or duplicates an input", () => {
    const all = inputs(37);
    const flat = planBatches(all, { maxBatchSize: 7, maxBatchTokens: 40 }).flat();
    expect(flat).toHaveLength(37);
  });

  it("rejects a single oversized input instead of sending an invalid batch", () => {
    expect(() =>
      planBatches([{ text: "word ".repeat(1000), kind: "document" }], {
        maxBatchSize: 10,
        maxBatchTokens: 10,
      }),
    ).toThrow(/budget/);
  });

  it("returns nothing for nothing", () => {
    expect(planBatches([], caps)).toEqual([]);
  });
});

describe("retry", () => {
  const failing = (fails: number, code: "rate_limited" | "invalid_request"): EmbeddingProvider => {
    let n = 0;
    return {
      id: "flaky",
      dimensions: EMBED_DIM,
      maxBatchSize: 10,
      maxBatchTokens: 1000,
      metered: false,
      embed(batch) {
        // A real MemweError, because that is what carries `retryable`. A
        // plain Error is deliberately treated as retryable — unknown
        // failures are assumed transient until proven otherwise.
        if (n++ < fails) throw new MemweError(code, "boom");
        return Promise.resolve(batch.map(() => new Array(EMBED_DIM).fill(0)));
      },
    };
  };

  it("recovers from a transient failure", async () => {
    const out = await embedBatch(failing(2, "rate_limited"), inputs(2), quiet);
    expect(out).toHaveLength(2);
  });

  it("gives up after the attempt budget", async () => {
    // Config is read per call, so the budget can be lowered here rather
    // than making the suite wait out real backoff.
    process.env["EMBED_MAX_ATTEMPTS"] = "2";
    await expect(embedBatch(failing(99, "rate_limited"), inputs(1), quiet)).rejects.toThrow("boom");
    delete process.env["EMBED_MAX_ATTEMPTS"];
  });

  it("does not retry a malformed request", async () => {
    // A 400 will be a 400 again; burning four attempts just delays the error.
    const started = Date.now();
    await expect(embedBatch(failing(99, "invalid_request"), inputs(1), quiet)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("treats an unknown throwable as transient", async () => {
    const p: EmbeddingProvider = {
      id: "odd",
      dimensions: EMBED_DIM,
      maxBatchSize: 1,
      maxBatchTokens: 10,
      metered: false,
      embed() {
        throw new Error("something unlabelled");
      },
    };
    process.env["EMBED_MAX_ATTEMPTS"] = "2";
    await expect(embedBatch(p, inputs(1), quiet)).rejects.toThrow("something unlabelled");
    delete process.env["EMBED_MAX_ATTEMPTS"];
  });
});

describe("dimension guard", () => {
  it("rejects a vector of the wrong size rather than writing it", () => {
    // A wrong-dimension vector written once is undetectable later.
    expect(() => assertDimensions([new Array(768).fill(0)], EMBED_DIM, "test")).toThrow(
      /768 dimensions, schema expects 1024/,
    );
  });

  it("accepts the right size", () => {
    expect(() => assertDimensions([new Array(EMBED_DIM).fill(0)], EMBED_DIM, "test")).not.toThrow();
  });
});
