import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { MemweError } from "@memwe/contracts";
import { z } from "zod";
import type { Logger } from "../log.js";

/**
 * Contextual chunk headers.
 *
 * One request per document, not one per chunk: the whole document goes in
 * first, the chunks that need context follow, and the model returns every
 * context in a single structured response. When a document has more chunks
 * than fit one pass, the document block carries a cache breakpoint so the
 * later passes read the prefix from cache instead of paying for it again.
 */

export type ContextDoc = { title: string | null; markdown: string };
export type ContextChunk = { ord: number; text: string; path: string | null };

export type ContextUsage = {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
};

export type PassResult = {
  /** ord -> context for every chunk the model answered. */
  contexts: Map<number, string>;
  /** Which model actually served the pass — a fallback can differ from the configured one. */
  model: string;
  /** Ords in the pass the model did not answer. */
  missing: number[];
  refused: boolean;
  usage: ContextUsage;
};

export type WriteHooks = {
  /** Runs before each request. Throw to stop spending — the fence, not the model, decides. */
  beforePass?: () => Promise<void>;
  /** Runs after each request. Persist here: a later pass may fail and the job may retry. */
  afterPass: (pass: PassResult) => Promise<void>;
};

export interface ContextProvider {
  /** Configuration identity: a stored context is reused only when its model equals this. */
  readonly id: string;
  write(doc: ContextDoc, chunks: ContextChunk[], hooks: WriteHooks, log: Logger): Promise<void>;
}

export type ContextConfig = {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  chunksPerPass: number;
  maxOutputTokens: number;
  maxContextChars: number;
  maxDocTokens: number;
};

const SYSTEM = [
  "You write retrieval context for chunks of a document.",
  "For each chunk you are given, write one or two sentences, at most 60 words, that situate the chunk within the whole document so that a search over chunks can find it:",
  "name the document or its subject, the section the chunk belongs to, and what the chunk specifically covers.",
  "Resolve pronouns, abbreviations and references the chunk leaves implicit.",
  "Do not summarize the whole document and do not repeat the chunk.",
  "Write in the document's language.",
  "Return exactly one entry per chunk, keyed by its ord.",
].join(" ");

const ContextOutput = z.object({
  contexts: z.array(z.object({ ord: z.number().int(), context: z.string() })),
});
// Built once: the schema is part of the cached prefix's bytes, so it must not vary.
const OUTPUT_FORMAT = betaZodOutputFormat(ContextOutput);
type ContextMessage = Anthropic.Beta.BetaMessage;

/**
 * Read per call, like the extractor and embedder: env captured at import
 * cannot be changed by a test or a deployment override.
 */
export function contextConfig(): ContextConfig {
  const int = (name: string, fallback: number) => {
    const n = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(n) || n <= 0)
      throw new MemweError("invalid_request", `${name} must be a positive integer`);
    return n;
  };
  const effort = process.env["CONTEXT_EFFORT"] ?? "low";
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort))
    throw new MemweError("invalid_request", `invalid CONTEXT_EFFORT ${effort}`);
  return {
    model: process.env["CONTEXT_MODEL"] ?? "claude-opus-5",
    effort: effort as ContextConfig["effort"],
    chunksPerPass: int("CONTEXT_CHUNKS_PER_PASS", 60),
    maxOutputTokens: int("CONTEXT_MAX_OUTPUT_TOKENS", 16_000),
    maxContextChars: int("CONTEXT_MAX_CHARS", 600),
    maxDocTokens: int("CONTEXT_MAX_DOC_TOKENS", 200_000),
  };
}

let cached: { provider: ContextProvider | null } | null = null;

/**
 * Choose a provider from the environment, and refuse to guess. Same rule as
 * embeddings: a metered model is only selected when its credential is
 * present, so no ingest job starts spending because a default said so.
 * Without one the pipeline keeps the heading path as the only context.
 */
export function contextProvider(log?: Logger): ContextProvider | null {
  if (cached) return cached.provider;
  const want = process.env["CONTEXT_PROVIDER"] ?? "auto";
  if (!["auto", "anthropic", "none"].includes(want))
    throw new MemweError("invalid_request", `unknown context provider ${want}`);
  const key = process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"];
  if (want === "anthropic" || (want === "auto" && key)) {
    cached = { provider: new AnthropicContext(new Anthropic(), contextConfig()) };
  } else {
    cached = { provider: null };
    log?.warn("no context model configured — chunks carry the heading path only", {
      why: want === "none" ? "CONTEXT_PROVIDER=none" : "no ANTHROPIC_API_KEY set",
    });
  }
  return cached.provider;
}

export function resetContextProvider(): void {
  cached = null;
}

function renderDoc(doc: ContextDoc): string {
  const title = doc.title ? ` title=${JSON.stringify(doc.title)}` : "";
  return `<document${title}>\n${doc.markdown}\n</document>`;
}

function renderChunks(chunks: ContextChunk[]): string {
  const body = chunks
    .map((k) => {
      const path = k.path ? ` path=${JSON.stringify(k.path)}` : "";
      return `<chunk ord="${k.ord}"${path}>\n${k.text}\n</chunk>`;
    })
    .join("\n\n");
  return `Write context for these ${chunks.length} chunks of the document above.\n\n${body}`;
}

function toMemweError(err: unknown): MemweError {
  if (err instanceof MemweError) return err;
  if (err instanceof Anthropic.RateLimitError)
    return new MemweError("rate_limited", `context model rate limited: ${err.message}`);
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    // The caller's fault: retrying a rejected request only repeats the rejection.
    if (status >= 400 && status < 500)
      return new MemweError("invalid_request", `context model rejected request: ${err.message}`);
    return new MemweError("upstream_failed", `context model failed: ${err.message}`);
  }
  return new MemweError(
    "upstream_failed",
    `context model failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

export class AnthropicContext implements ContextProvider {
  readonly id: string;
  constructor(
    private readonly client: Anthropic,
    private readonly cfg: ContextConfig,
  ) {
    this.id = cfg.model;
  }

  async write(
    doc: ContextDoc,
    chunks: ContextChunk[],
    hooks: WriteHooks,
    log: Logger,
  ): Promise<void> {
    if (chunks.length === 0) return;
    const passes: ContextChunk[][] = [];
    for (let i = 0; i < chunks.length; i += this.cfg.chunksPerPass)
      passes.push(chunks.slice(i, i + this.cfg.chunksPerPass));
    // A cache write costs 1.25x and only pays for itself when something
    // reads it back: the second pass, or a retry within the TTL.
    const cache = passes.length > 1;
    const docBlock = renderDoc(doc);
    let cacheReads = 0;
    const observed: WriteHooks = {
      ...(hooks.beforePass ? { beforePass: hooks.beforePass } : {}),
      afterPass: async (pass) => {
        cacheReads += pass.usage.cacheReadTokens;
        await hooks.afterPass(pass);
      },
    };
    for (const pass of passes) await this.runPass(docBlock, pass, cache, observed, log);
    // Marked but never read back means the prefix changed between passes —
    // every pass paid full price plus the write premium. The live test in
    // tests/context-live.test.ts is where this is asserted; here it is only
    // reported, because the contexts themselves are fine.
    if (cache && cacheReads === 0)
      log.warn("document prefix was never read from cache — check for a silent invalidator", {
        passes: passes.length,
        model: this.cfg.model,
      });
  }

  private async runPass(
    docBlock: string,
    pass: ContextChunk[],
    cache: boolean,
    hooks: WriteHooks,
    log: Logger,
  ): Promise<void> {
    await hooks.beforePass?.();
    let message: ContextMessage;
    try {
      message = await this.request(docBlock, pass, cache);
    } catch (err) {
      throw toMemweError(err);
    }
    const usage: ContextUsage = {
      inputTokens: message.usage.input_tokens,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      outputTokens: message.usage.output_tokens,
    };
    const ords = pass.map((k) => k.ord);
    log.debug("context pass", {
      chunks: pass.length,
      model: message.model,
      stopReason: message.stop_reason,
      ...usage,
    });

    if (message.stop_reason === "max_tokens") {
      // The answer did not fit. Halve the pass rather than retrying the same
      // request into the same ceiling; the cached prefix makes this cheap.
      if (pass.length > 1) {
        const mid = Math.ceil(pass.length / 2);
        log.warn("context response truncated — splitting the pass", { chunks: pass.length });
        await this.runPass(docBlock, pass.slice(0, mid), true, hooks, log);
        await this.runPass(docBlock, pass.slice(mid), true, hooks, log);
        return;
      }
      throw new MemweError(
        "unsupported_content",
        "context for one chunk exceeded the output limit",
      );
    }
    if (message.stop_reason === "refusal") {
      log.warn("context model refused", {
        chunks: pass.length,
        category: message.stop_details?.category ?? null,
      });
      await hooks.afterPass({
        contexts: new Map(),
        model: message.model,
        missing: ords,
        refused: true,
        usage,
      });
      return;
    }
    // Parsed here, after the stop reason is known: the SDK's own parser
    // throws on the partial JSON of a truncated or refused answer.
    const text = message.content.find((b) => b.type === "text")?.text;
    if (!text) throw new MemweError("upstream_failed", "context model returned no text");
    let parsed: z.infer<typeof ContextOutput>;
    try {
      parsed = OUTPUT_FORMAT.parse(text);
    } catch (err) {
      throw new MemweError(
        "upstream_failed",
        `context model output did not match the schema: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const wanted = new Set(ords);
    const contexts = new Map<number, string>();
    let truncated = 0;
    for (const entry of parsed.contexts) {
      if (!wanted.has(entry.ord) || contexts.has(entry.ord)) continue;
      let text = entry.context.replace(/\s+/g, " ").trim();
      if (text.length === 0) continue;
      if (text.length > this.cfg.maxContextChars) {
        text = text.slice(0, this.cfg.maxContextChars).trimEnd();
        truncated++;
      }
      contexts.set(entry.ord, text);
    }
    const missing = ords.filter((o) => !contexts.has(o));
    if (contexts.size === 0)
      throw new MemweError("upstream_failed", "context model answered none of the chunks");
    if (missing.length > 0 || truncated > 0)
      log.warn("context pass incomplete", { missing, truncated });
    await hooks.afterPass({ contexts, model: message.model, missing, refused: false, usage });
  }

  private request(docBlock: string, pass: ContextChunk[], cache: boolean): Promise<ContextMessage> {
    return this.client.beta.messages.create({
      model: this.cfg.model,
      max_tokens: this.cfg.maxOutputTokens,
      // A policy decline is re-run on a fallback model inside the same call
      // instead of leaving the pass without context.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            // Stable prefix. The chunk list after it is what varies between passes.
            {
              type: "text",
              text: docBlock,
              ...(cache ? { cache_control: { type: "ephemeral" } } : {}),
            },
            { type: "text", text: renderChunks(pass) },
          ],
        },
      ],
      output_config: { effort: this.cfg.effort, format: OUTPUT_FORMAT },
    });
  }
}
