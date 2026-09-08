import Anthropic from "@anthropic-ai/sdk";
import { MemweError } from "@memwe/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicContext,
  type ContextConfig,
  contextConfig,
  contextProvider,
  type PassResult,
  resetContextProvider,
} from "../apps/worker/src/context/index.js";
import { logger } from "../apps/worker/src/log.js";
import { embeddingInput } from "../apps/worker/src/stages/chunk.js";
import { fakeAnthropic, requestedOrds } from "./helpers/anthropic.js";

const log = logger({ svc: "test" });
const cfg: ContextConfig = {
  model: "claude-opus-5",
  effort: "low",
  chunksPerPass: 60,
  maxOutputTokens: 16_000,
  maxContextChars: 600,
  maxDocTokens: 200_000,
};
const doc = { title: "Guide", markdown: "# Guide\n\nAlpha.\n\nBeta.\n\nGamma." };
const chunks = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ ord: i, text: `chunk ${i}`, path: `Guide › S${i}` }));

function writer(fetch: typeof globalThis.fetch, over: Partial<ContextConfig> = {}) {
  const client = new Anthropic({ apiKey: "test", fetch, maxRetries: 0 });
  return new AnthropicContext(client, { ...cfg, ...over });
}
async function collect(w: AnthropicContext, n: number) {
  const passes: PassResult[] = [];
  let before = 0;
  await w.write(
    doc,
    chunks(n),
    {
      beforePass: async () => {
        before++;
      },
      afterPass: async (p) => {
        passes.push(p);
      },
    },
    log,
  );
  return { passes, before };
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetContextProvider();
});

describe("context request contract", () => {
  it("sends the whole document first, then every chunk, and asks for structured output", async () => {
    const fake = fakeAnthropic();
    const { passes, before } = await collect(writer(fake.fetch), 3);
    expect(fake.calls).toHaveLength(1);
    expect(before).toBe(1);
    const body = fake.calls[0]!.body;
    expect(body.model).toBe("claude-opus-5");
    expect(body.max_tokens).toBe(16_000);
    expect(body.fallbacks).toBe("default");
    expect(fake.calls[0]!.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!
      .content;
    expect(content[0]!.text).toContain('<document title="Guide">');
    expect(content[0]!.text).toContain(doc.markdown);
    // One pass: nothing would read a cache entry, so none is written.
    expect(content[0]!.cache_control).toBeUndefined();
    expect(requestedOrds(body)).toEqual([0, 1, 2]);
    expect(content[1]!.text).toContain('path="Guide › S1"');
    const out = body.output_config as { effort: string; format: { type: string } };
    expect(out.effort).toBe("low");
    expect(out.format.type).toBe("json_schema");
    expect(passes).toHaveLength(1);
    expect([...passes[0]!.contexts]).toEqual([
      [0, "ctx 0"],
      [1, "ctx 1"],
      [2, "ctx 2"],
    ]);
    expect(passes[0]!.model).toBe("claude-opus-5");
  });

  it("caches the document prefix across passes and keeps its bytes identical", async () => {
    const fake = fakeAnthropic((body) => ({
      ...{ contexts: requestedOrds(body).map((ord) => ({ ord, context: `ctx ${ord}` })) },
      usage: { cache_read_input_tokens: body.messages ? 90 : 0 },
    }));
    const { passes } = await collect(writer(fake.fetch, { chunksPerPass: 2 }), 5);
    expect(fake.calls).toHaveLength(3);
    const docBlocks = fake.calls.map(
      (c) =>
        (c.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content[0]!,
    );
    for (const b of docBlocks) expect(b.cache_control).toEqual({ type: "ephemeral" });
    expect(new Set(docBlocks.map((b) => b.text)).size).toBe(1);
    expect(fake.calls.map((c) => requestedOrds(c.body))).toEqual([[0, 1], [2, 3], [4]]);
    expect(passes.map((p) => p.usage.cacheReadTokens)).toEqual([90, 90, 90]);
    expect(passes.flatMap((p) => [...p.contexts.keys()])).toEqual([0, 1, 2, 3, 4]);
  });

  it("warns when a multi-pass document never reads its prefix back", async () => {
    const warn = vi.spyOn(log, "warn");
    // The default fake reports zero cache reads.
    await collect(writer(fakeAnthropic().fetch, { chunksPerPass: 2 }), 3);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/never read from cache/),
      expect.objectContaining({ passes: 2 }),
    );
    warn.mockClear();
    // One pass has nothing to read back, so nothing to warn about.
    await collect(writer(fakeAnthropic().fetch), 3);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("splits a pass whose answer was cut off instead of retrying into the same ceiling", async () => {
    const fake = fakeAnthropic((body) => {
      const ords = requestedOrds(body);
      // Cut off mid-JSON, as a real truncation is.
      if (ords.length > 2) return { text: '{"contexts":[{"ord":0,"con', stopReason: "max_tokens" };
      return { contexts: ords.map((ord) => ({ ord, context: `ctx ${ord}` })) };
    });
    const { passes } = await collect(writer(fake.fetch), 4);
    expect(fake.calls.map((c) => requestedOrds(c.body))).toEqual([
      [0, 1, 2, 3],
      [0, 1],
      [2, 3],
    ]);
    expect(passes.flatMap((p) => [...p.contexts.keys()])).toEqual([0, 1, 2, 3]);
  });

  it("drops answers for unknown ords, trims, caps length, and reports what is missing", async () => {
    const fake = fakeAnthropic(() => ({
      contexts: [
        { ord: 0, context: "  spaced\n\nout  " },
        { ord: 0, context: "duplicate" },
        { ord: 7, context: "not asked" },
        { ord: 2, context: "x".repeat(50) },
        { ord: 1, context: "   " },
      ],
    }));
    const { passes } = await collect(writer(fake.fetch, { maxContextChars: 20 }), 3);
    const p = passes[0]!;
    expect(p.contexts.get(0)).toBe("spaced out");
    expect(p.contexts.get(2)).toBe("x".repeat(20));
    expect(p.contexts.has(7)).toBe(false);
    expect(p.missing).toEqual([1]);
  });

  it("treats a refusal as a pass with no contexts rather than a failure", async () => {
    const fake = fakeAnthropic(() => ({
      text: "",
      stopReason: "refusal",
      stopDetails: { type: "refusal", category: "other", explanation: "no" },
    }));
    const { passes } = await collect(writer(fake.fetch), 2);
    expect(passes[0]).toMatchObject({ refused: true, missing: [0, 1] });
    expect(passes[0]!.contexts.size).toBe(0);
  });

  it("maps provider errors onto the retry taxonomy", async () => {
    const cases: Array<[number, string, boolean]> = [
      [429, "rate_limited", true],
      [400, "invalid_request", false],
      [401, "invalid_request", false],
      [500, "upstream_failed", true],
      [529, "upstream_failed", true],
    ];
    for (const [status, code, retryable] of cases) {
      const fake = fakeAnthropic(() => ({
        status,
        error: { type: "api_error", message: `status ${status}` },
      }));
      const err = await collect(writer(fake.fetch), 1).catch((e) => e);
      expect(err).toBeInstanceOf(MemweError);
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(retryable);
    }
  });

  it("fails a pass the model answered nothing for, so the job retries", async () => {
    const fake = fakeAnthropic(() => ({ contexts: [] }));
    await expect(collect(writer(fake.fetch), 2)).rejects.toThrow(/answered none/);
  });
});

describe("context provider selection", () => {
  it("never picks a metered model without a credential", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    vi.stubEnv("CONTEXT_PROVIDER", "auto");
    expect(contextProvider(log)).toBeNull();
    resetContextProvider();
    vi.stubEnv("CONTEXT_PROVIDER", "none");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    expect(contextProvider(log)).toBeNull();
    resetContextProvider();
    vi.stubEnv("CONTEXT_PROVIDER", "auto");
    expect(contextProvider(log)?.id).toBe("claude-opus-5");
    resetContextProvider();
    vi.stubEnv("CONTEXT_PROVIDER", "bogus");
    expect(() => contextProvider(log)).toThrow(/unknown context provider/);
  });

  it("rejects nonsense configuration instead of running with it", () => {
    vi.stubEnv("CONTEXT_CHUNKS_PER_PASS", "0");
    expect(() => contextConfig()).toThrow(/CONTEXT_CHUNKS_PER_PASS/);
    vi.stubEnv("CONTEXT_CHUNKS_PER_PASS", "10");
    vi.stubEnv("CONTEXT_EFFORT", "turbo");
    expect(() => contextConfig()).toThrow(/CONTEXT_EFFORT/);
  });
});

describe("embedding input", () => {
  it("puts the generated context before the heading path and the text", () => {
    expect(embeddingInput("body", "A › B", "situates")).toBe("situates\nA › B\n\nbody");
    expect(embeddingInput("body", "A › B")).toBe("A › B\n\nbody");
    expect(embeddingInput("body", null, "situates")).toBe("situates\n\nbody");
    expect(embeddingInput("body", null)).toBe("body");
  });
});
