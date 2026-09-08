import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { tokens, warmTokenizer } from "../apps/worker/src/chunk/tokens.js";
import {
  AnthropicContext,
  type ContextChunk,
  contextConfig,
  type PassResult,
} from "../apps/worker/src/context/index.js";
import { logger } from "../apps/worker/src/log.js";

/**
 * The one thing the fake Messages API cannot prove: that the document
 * prefix we mark is byte-stable between passes and actually comes back from
 * the cache. A silent invalidator — a timestamp, a reordered key, a schema
 * that differs per request — shows up only here, as zero cache reads.
 *
 * Spends real money (a few cents), so opt-in:
 *   RUN_LIVE_MODEL_TESTS=1 ANTHROPIC_API_KEY=... pnpm test
 * CI sets both from the repository secret; fork PRs, which have no secrets,
 * skip it.
 */
const live = process.env.RUN_LIVE_MODEL_TESTS === "1" ? it : it.skip;

/**
 * Deterministic on purpose: a re-run inside the cache TTL reads on the first
 * pass instead of writing, which is fine and asserted below. Sized above the
 * largest minimum cacheable prefix of any current model (4096 tokens on
 * Haiku 4.5), so the assertion holds whichever CONTEXT_MODEL is configured.
 */
function probeDocument(): { markdown: string; chunks: ContextChunk[] } {
  const sections: string[] = [];
  const chunks: ContextChunk[] = [];
  for (let s = 0; s < 4; s++) {
    const body = Array.from(
      { length: 60 },
      (_, i) =>
        `Item ${i + 1} of section ${s + 1} records that shipment ${s * 100 + i} left warehouse ${(i % 7) + 1} on day ${(i * 3) % 28}.`,
    ).join(" ");
    const text = `## Section ${s + 1}\n\n${body}`;
    sections.push(text);
    chunks.push({ ord: s, text, path: `Cache probe › Section ${s + 1}` });
  }
  return { markdown: `# Cache probe\n\n${sections.join("\n\n")}`, chunks };
}

describe("prompt cache, live", () => {
  live(
    "reads the document prefix from cache on every pass after the first",
    { timeout: 300_000 },
    async () => {
      await warmTokenizer();
      const { markdown, chunks } = probeDocument();
      const docTokens = tokens.count(markdown);
      expect(docTokens).toBeGreaterThan(4096);

      // Two chunks per pass forces a second request that shares the prefix.
      const writer = new AnthropicContext(new Anthropic(), {
        ...contextConfig(),
        chunksPerPass: 2,
      });
      const passes: PassResult[] = [];
      await writer.write(
        { title: "Cache probe", markdown },
        chunks,
        {
          afterPass: async (p) => {
            passes.push(p);
          },
        },
        logger({ svc: "test" }),
      );
      expect(passes).toHaveLength(2);
      const [first, second] = passes as [PassResult, PassResult];
      console.log(
        `cache probe: pass1 write=${first.usage.cacheWriteTokens} read=${first.usage.cacheReadTokens} ` +
          `pass2 write=${second.usage.cacheWriteTokens} read=${second.usage.cacheReadTokens} ` +
          `uncached=${second.usage.inputTokens} model=${second.model}`,
      );

      // First pass either writes the entry or, on a re-run inside the TTL, reads it.
      expect(first.usage.cacheWriteTokens + first.usage.cacheReadTokens).toBeGreaterThan(0);
      // THE assertion. Zero here means the prefix changed between passes.
      expect(second.usage.cacheReadTokens).toBeGreaterThan(0);
      // And it is the document that was read back, not just the system prompt.
      // Tokenizers differ, so the bound is loose; the o200k count is within
      // ~1.35x of the model's own.
      expect(second.usage.cacheReadTokens).toBeGreaterThanOrEqual(docTokens * 0.5);
      // What was billed at full price on the second pass is only the chunk list.
      expect(second.usage.inputTokens).toBeLessThan(second.usage.cacheReadTokens);

      expect([...first.contexts.keys(), ...second.contexts.keys()]).toEqual([0, 1, 2, 3]);
    },
  );
});
