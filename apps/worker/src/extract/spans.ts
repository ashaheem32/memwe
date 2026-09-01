import type { SpanMapEntry } from "@memwe/contracts";

/**
 * A span map is only useful if it is small enough to store and accurate
 * enough to trust. We emit an entry wherever output and source offsets
 * diverge, not per character.
 */
const MAX_ENTRIES = 10_000;

export class SpanMap {
  private readonly entries: SpanMapEntry[] = [];
  private lastDelta: number | null = null;
  private truncatedAt: number | null = null;

  /** Record that markdown offset `md` corresponds to source offset `src`. */
  mark(md: number, src: number, page?: number): void {
    if (this.entries.length >= MAX_ENTRIES) {
      this.truncatedAt ??= md;
      return;
    }
    const delta = src - md;
    const prev = this.entries[this.entries.length - 1];
    // Only a change in the offset delta, or a new page, carries information.
    if (this.lastDelta === delta && (page === undefined || page === prev?.page)) return;
    this.lastDelta = delta;
    this.entries.push(page === undefined ? { md, src } : { md, src, page });
  }

  /** True when the map stopped being complete — callers must say so. */
  get truncated(): number | null {
    return this.truncatedAt;
  }

  toJSON(): SpanMapEntry[] {
    return this.entries;
  }
}

/**
 * Normalise line endings and record the shift. Every CRLF collapsed to LF
 * moves all following source offsets by one; a map that ignores that is
 * quietly wrong for every Windows-authored document.
 */
export function normalizeNewlines(text: string, map: SpanMap, srcBase = 0): string {
  if (!text.includes("\r")) {
    map.mark(0, srcBase);
    return text;
  }
  let out = "";
  let src = srcBase;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++; // CRLF -> LF
      map.mark(out.length, src);
      out += "\n";
      src += text[i] === "\n" ? 2 : 1;
      continue;
    }
    out += ch;
    src += 1;
  }
  map.mark(out.length, src);
  return out;
}
