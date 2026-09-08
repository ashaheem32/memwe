import type { SourceLocation, SpanMapEntry } from "@memwe/contracts";

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

  /**
   * Record that markdown offset `md` corresponds to source offset `src`.
   *
   * Entries are segment starts, not points: a segment runs to the next
   * entry's `md`, and within it the mapping is 1:1 because a new entry is
   * emitted precisely when the offset delta changes. That invariant is what
   * lets `resolveSpan` interpolate instead of guessing.
   */
  mark(
    md: number,
    src: number,
    loc?: {
      page?: number;
      bbox?: SpanMapEntry["bbox"];
      mdEnd?: number;
      srcEnd?: number;
      exact?: boolean;
    },
  ): void {
    if (this.entries.length >= MAX_ENTRIES) {
      if (this.truncatedAt === null) {
        this.truncatedAt = md;
        this.entries.push({ md, src, mdEnd: md, srcEnd: src, exact: false });
      }
      return;
    }
    const delta = src - md;
    const prev = this.entries[this.entries.length - 1];
    const page = loc?.page;
    const bbox = loc?.bbox;
    // Only a change in delta, page, or geometry carries information.
    const samePlace = this.lastDelta === delta && page === prev?.page && bbox === undefined;
    if (
      samePlace &&
      loc?.mdEnd === undefined &&
      loc?.exact === undefined &&
      prev?.mdEnd === undefined
    )
      return;
    this.lastDelta = delta;
    const entry: SpanMapEntry = { md, src };
    if (page !== undefined) entry.page = page;
    if (bbox !== undefined) entry.bbox = bbox;
    if (loc?.mdEnd !== undefined) entry.mdEnd = loc.mdEnd;
    if (loc?.srcEnd !== undefined) entry.srcEnd = loc.srcEnd;
    if (loc?.exact !== undefined) entry.exact = loc.exact;
    this.entries.push(entry);
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

/**
 * Resolve a range of the emitted markdown back to where it came from.
 *
 * This is the whole point of storing a span map. `/why` shows a reader the
 * sentences behind a memory; the memory-review UI highlights them; the
 * ACL-intersection rule needs to know which source documents a fact touched.
 * All of it goes through here.
 *
 * A range can straddle segments — a paragraph spanning two PDF pages, a
 * chunk crossing a de-hyphenated join — so this returns every location the
 * range touches, in order, rather than a single answer.
 */
export function resolveSpan(
  entries: readonly SpanMapEntry[],
  mdStart: number,
  mdEnd: number,
  opts: { markdownLength?: number; truncatedAt?: number | null } = {},
): SourceLocation[] {
  if (mdEnd <= mdStart || entries.length === 0) return [];
  const end = Math.min(
    opts.markdownLength ?? Number.MAX_SAFE_INTEGER,
    opts.truncatedAt ?? Number.MAX_SAFE_INTEGER,
  );

  const out: SourceLocation[] = [];
  for (let i = 0; i < entries.length; i++) {
    const seg = entries[i];
    if (!seg) continue;
    const segStart = seg.md;
    const segEnd = Math.min(seg.mdEnd ?? Number.MAX_SAFE_INTEGER, entries[i + 1]?.md ?? end, end);
    if (segEnd <= mdStart) continue;
    if (segStart >= mdEnd) break;

    // Clip the requested range to this segment, then shift by the segment's
    // constant delta.
    const from = Math.max(mdStart, segStart);
    const to = Math.min(mdEnd, segEnd);
    const delta = seg.src - seg.md;

    const loc: SourceLocation = {
      srcStart: seg.exact === false ? seg.src : from + delta,
      srcEnd: seg.exact === false ? (seg.srcEnd ?? seg.src) : to + delta,
      exact: seg.exact !== false,
    };
    if (seg.page !== undefined) loc.page = seg.page;
    if (seg.bbox !== undefined) loc.bbox = seg.bbox;
    out.push(loc);
  }

  // Merge adjacent locations that are contiguous on the same page — a
  // paragraph split across four segments should read as one citation.
  const merged: SourceLocation[] = [];
  for (const loc of out) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.page === loc.page &&
      prev.exact &&
      loc.exact &&
      prev.bbox === undefined &&
      loc.bbox === undefined &&
      prev.srcEnd === loc.srcStart
    ) {
      prev.srcEnd = loc.srcEnd;
      continue;
    }
    merged.push(loc);
  }
  return merged;
}
