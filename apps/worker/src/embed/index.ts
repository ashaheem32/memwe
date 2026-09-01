import { MemweError } from "@memwe/contracts";
import { tokens } from "../chunk/tokens.js";
import type { Logger } from "../log.js";
import { HashEmbedding } from "./hash.js";
import { openAICompatible, voyage } from "./http.js";
import { EMBED_DIM, type EmbeddingProvider, type EmbedInput } from "./provider.js";

export type { EmbeddingProvider } from "./provider.js";
export { EMBED_DIM } from "./provider.js";

let cached: EmbeddingProvider | null = null;

/**
 * Choose a provider from the environment, and refuse to guess.
 *
 * A metered provider is only ever selected when its key is present — no
 * ingest job may start spending money because a default said so. And the
 * free stand-in refuses to run in production, because a corpus embedded
 * with it retrieves nothing useful and nothing about the pipeline would
 * look broken.
 */
export function provider(log?: Logger): EmbeddingProvider {
  if (cached) return cached;

  const want = process.env["EMBED_PROVIDER"] ?? "auto";
  const voyageKey = process.env["VOYAGE_API_KEY"];
  const openaiKey = process.env["OPENAI_API_KEY"] ?? process.env["EMBED_API_KEY"];
  const openaiUrl = process.env["EMBED_URL"] ?? "https://api.openai.com/v1/embeddings";
  const openaiModel = process.env["EMBED_MODEL"] ?? "text-embedding-3-large";

  if (want === "voyage" || (want === "auto" && voyageKey)) {
    if (!voyageKey)
      throw new MemweError("invalid_request", "EMBED_PROVIDER=voyage needs VOYAGE_API_KEY");
    cached = voyage(voyageKey, process.env["EMBED_MODEL"] ?? "voyage-3-large");
  } else if (want === "openai" || (want === "auto" && openaiKey)) {
    if (!openaiKey)
      throw new MemweError(
        "invalid_request",
        "EMBED_PROVIDER=openai needs OPENAI_API_KEY or EMBED_API_KEY",
      );
    cached = openAICompatible(openaiKey, openaiModel, openaiUrl);
  } else {
    if (process.env["NODE_ENV"] === "production" && process.env["EMBED_ALLOW_HASH"] !== "true") {
      throw new MemweError(
        "invalid_request",
        "no embedding provider configured. Set VOYAGE_API_KEY or OPENAI_API_KEY, " +
          "or EMBED_ALLOW_HASH=true to knowingly run with non-semantic vectors.",
      );
    }
    cached = new HashEmbedding();
    log?.warn("using the hash embedding stand-in — vectors are NOT semantic", {
      model: cached.id,
      why: "no VOYAGE_API_KEY or OPENAI_API_KEY set",
    });
  }

  if (cached.dimensions !== EMBED_DIM) {
    throw new MemweError(
      "invalid_request",
      `provider ${cached.id} emits ${cached.dimensions} dimensions; the schema column is ${EMBED_DIM}`,
    );
  }
  return cached;
}

/** Tests and config changes need a clean slate. */
export function resetProvider(): void {
  cached = null;
}

/**
 * Pack inputs into batches that respect both of the provider's caps.
 *
 * Token-aware, not just count-aware: 128 chunks of 600 tokens is 77k
 * tokens, and a provider that caps a request at 120k will reject a batch
 * that merely counted rows.
 */
export function planBatches(
  inputs: EmbedInput[],
  p: Pick<EmbeddingProvider, "maxBatchSize" | "maxBatchTokens">,
): EmbedInput[][] {
  const batches: EmbedInput[][] = [];
  let current: EmbedInput[] = [];
  let currentTokens = 0;

  for (const input of inputs) {
    const n = tokens.count(input.text);
    const full = current.length >= p.maxBatchSize;
    const wouldOverflow = current.length > 0 && currentTokens + n > p.maxBatchTokens;
    if (full || wouldOverflow) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(input);
    currentTokens += n;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Read per call. Same lesson as the PDF extractor: env captured at import
 * time cannot be changed by a test or a deployment override without
 * re-importing the module.
 */
function maxAttempts(): number {
  return Number(process.env["EMBED_MAX_ATTEMPTS"] ?? 4);
}

/**
 * One batch, with retry. Rate limits and upstream failures are transient;
 * a malformed request is not, so it fails straight through rather than
 * burning four attempts to be told the same thing.
 */
export async function embedBatch(
  p: EmbeddingProvider,
  batch: EmbedInput[],
  log: Logger,
): Promise<number[][]> {
  let lastError: unknown;
  const limit = maxAttempts();
  for (let attempt = 1; attempt <= limit; attempt++) {
    try {
      return await p.embed(batch);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof MemweError ? err.retryable : true;
      if (!retryable || attempt === limit) break;
      const wait = Math.round(2 ** attempt * 250 * (0.8 + Math.random() * 0.4));
      log.warn("embedding batch failed, retrying", {
        provider: p.id,
        attempt,
        size: batch.length,
        waitMs: wait,
        err: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new MemweError("upstream_failed", "embedding failed");
}

export type EmbedResult = { vectors: number[][]; batches: number; model: string; dims: number };

export async function embedAll(
  texts: string[],
  log: Logger,
  kind: EmbedInput["kind"] = "document",
): Promise<EmbedResult> {
  const p = provider(log);
  const inputs: EmbedInput[] = texts.map((text) => ({ text, kind }));
  const batches = planBatches(inputs, p);

  const vectors: number[][] = [];
  for (const [i, batch] of batches.entries()) {
    const started = Date.now();
    const out = await embedBatch(p, batch, log);
    vectors.push(...out);
    log.debug("embedded batch", {
      provider: p.id,
      batch: i + 1,
      of: batches.length,
      size: batch.length,
      ms: Date.now() - started,
    });
  }
  return { vectors, batches: batches.length, model: p.id, dims: p.dimensions };
}
