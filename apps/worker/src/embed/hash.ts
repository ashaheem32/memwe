import { createHash } from "node:crypto";
import { EMBED_DIM, type EmbeddingProvider, type EmbedInput } from "./provider.js";

/**
 * A deterministic, free, offline stand-in.
 *
 * It is NOT semantic: "cat" and "kitten" land nowhere near each other. It
 * exists so the pipeline is complete and testable without an API key or a
 * gigabyte of model weights — which matters while the spend cap is still
 * unset, and matters in CI forever.
 *
 * Everything it writes is stamped `hash-v1`, so a corpus embedded with it
 * is visible in one query and re-embeds cleanly once a real provider is
 * configured. It refuses to run in production.
 */
export class HashEmbedding implements EmbeddingProvider {
  readonly id = "hash-v1";
  readonly dimensions = EMBED_DIM;
  readonly maxBatchSize = 512;
  readonly maxBatchTokens = 1_000_000;
  readonly metered = false;

  embed(inputs: EmbedInput[]): Promise<number[][]> {
    return Promise.resolve(inputs.map((i) => this.one(i.text)));
  }

  /**
   * Hashed bag of tokens: shared words move two texts in the same
   * direction, so exact-duplicate detection and plumbing tests behave
   * sensibly even though nothing here understands meaning.
   */
  private one(text: string): number[] {
    const vec = new Float64Array(this.dimensions);
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const word of words) {
      const digest = createHash("sha256").update(word).digest();
      for (let i = 0; i < 8; i++) {
        const slot = digest.readUInt16BE(i * 2) % this.dimensions;
        const sign = (digest[16 + i] ?? 0) % 2 === 0 ? 1 : -1;
        vec[slot] = (vec[slot] ?? 0) + sign;
      }
    }
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return Array.from(vec, (v) => v / norm);
  }
}
