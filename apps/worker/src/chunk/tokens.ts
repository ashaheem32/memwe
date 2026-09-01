/**
 * Token counting, behind an interface because the number that actually
 * matters belongs to the embedding model, and that is not chosen yet.
 *
 * o200k is a stand-in: for English it lands within ~10% of most embedding
 * tokenizers, which is fine for a 600-token *budget*. It is not fine for a
 * hard limit check — when embeddings land, the provider's own count goes
 * here and the budget re-tunes against it.
 *
 * A chars/4 heuristic was measured and rejected: -72% on emoji and -38% on
 * code, which is precisely where a hard limit gets exceeded.
 */
export interface TokenCounter {
  count(text: string): number;
  /** Truncate to at most `max` tokens, on a token boundary. */
  truncate(text: string, max: number): string;
}

type Encoding = {
  encode: (t: string) => number[];
  decode: (t: number[]) => string;
};

let encoding: Encoding | null = null;

async function load(): Promise<Encoding> {
  encoding ??= (await import("gpt-tokenizer/encoding/o200k_base")) as unknown as Encoding;
  return encoding;
}

/** Load once at worker start so no chunk pays the ~70ms init. */
export async function warmTokenizer(): Promise<void> {
  await load();
}

class O200kCounter implements TokenCounter {
  count(text: string): number {
    if (!encoding) throw new Error("tokenizer not warmed — call warmTokenizer() first");
    return encoding.encode(text).length;
  }
  truncate(text: string, max: number): string {
    if (!encoding) throw new Error("tokenizer not warmed — call warmTokenizer() first");
    const ids = encoding.encode(text);
    return ids.length <= max ? text : encoding.decode(ids.slice(0, max));
  }
}

export const tokens: TokenCounter = new O200kCounter();
