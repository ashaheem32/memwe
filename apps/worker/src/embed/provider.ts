import { MemweError } from "@memwe/contracts";

/**
 * The dimension the schema commits to. 1024 is what voyage-3-large,
 * gemini-embedding-001 and bge-m3 all produce, so the column does not have
 * to move when the provider does.
 *
 * A provider returning anything else is a hard error, never a silent
 * truncation — a wrong-dimension vector written once is undetectable later.
 */
export const EMBED_DIM = 1024;

export type EmbedInput = { text: string; kind: "document" | "query" };

export interface EmbeddingProvider {
  /** Stamped onto every row so a dual-write migration can tell generations apart. */
  readonly id: string;
  readonly dimensions: number;
  /** Provider's own per-request caps. Batching respects both. */
  readonly maxBatchSize: number;
  readonly maxBatchTokens: number;
  /** True when a call costs money. Gates it behind an explicit key. */
  readonly metered: boolean;
  embed(inputs: EmbedInput[]): Promise<number[][]>;
}

export function assertDimensions(vectors: number[][], expected: number, provider: string): void {
  for (const v of vectors) {
    if (v.length !== expected) {
      throw new MemweError(
        "internal",
        `${provider} returned ${v.length} dimensions, schema expects ${expected}`,
        { provider, got: v.length, expected },
      );
    }
  }
}
