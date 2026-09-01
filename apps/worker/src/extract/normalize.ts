/**
 * Normalization proper: everything between "we decoded some bytes" and
 * "this is text a chunker and an embedding model can work with".
 *
 * Every rule here changes offsets, which is why normalization and the span
 * map cannot be separate passes. A map built before normalization points at
 * the wrong characters; one built after has nothing to point at.
 *
 * Accuracy is line-level by construction: a segment is emitted at each line
 * whose offset delta changed. That is what provenance actually needs — you
 * show a reader a sentence, not a character — and it is a guarantee that
 * survives NFC, which is not a per-character operation.
 */
import type { SpanMap } from "./spans.js";

const LIGATURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/ﬀ/g, "ff"],
  [/ﬁ/g, "fi"],
  [/ﬂ/g, "fl"],
  [/ﬃ/g, "ffi"],
  [/ﬄ/g, "ffl"],
  [/ﬅ/g, "st"],
  [/ﬆ/g, "st"],
];

/**
 * Invisible characters worth removing. Deliberately NOT here:
 *   U+200C ZWNJ and U+200D ZWJ — semantic in Arabic, Devanagari and emoji.
 * Stripping ZWJ turns 👨‍👩‍👧‍👦 into four separate people.
 */
const INVISIBLE = /[­​﻿⁠]/g;

/** Unicode spaces that should just be spaces. */
const ODD_SPACE = /[  -   　]/g;

export type NormalizeOptions = {
  /** Join `extrac-\ntion` across a line break. PDFs need it; markdown must not. */
  dehyphenate?: boolean;
  /**
   * Collapse runs of blank lines to at most this many. One is the
   * paragraph separator; more is just vertical space from a PDF layout.
   */
  maxBlankLines?: number;
};

export function normalizeLine(line: string): string {
  let out = line.normalize("NFC");
  for (const [re, to] of LIGATURES) out = out.replace(re, to);
  out = out.replace(INVISIBLE, "");
  out = out.replace(ODD_SPACE, " ");
  return out.replace(/[ \t]+$/, "");
}

/**
 * A trailing hyphen is only a broken word if the next line continues one.
 * "well-\nknown" is a real compound; "extrac-\ntion" is not. The heuristic:
 * join only when the next line starts lowercase and the fragment before the
 * hyphen is not itself a complete lowercase word followed by a capital.
 */
export function isBrokenWord(current: string, next: string): boolean {
  if (!/[\p{Ll}\p{Lo}]-$/u.test(current)) return false;
  return /^[\p{Ll}\p{Lo}]/u.test(next.trimStart());
}

export function normalizeText(
  raw: string,
  map: SpanMap,
  srcBase = 0,
  opts: NormalizeOptions = {},
): string {
  const { dehyphenate = false, maxBlankLines = 1 } = opts;

  // Split on any line ending, remembering how many source characters each
  // terminator consumed so CRLF does not silently shift everything after it.
  const lines: Array<{ text: string; srcStart: number; srcLen: number }> = [];
  let i = 0;
  let cursor = srcBase;
  while (i <= raw.length) {
    let end = i;
    while (end < raw.length && raw[end] !== "\n" && raw[end] !== "\r") end++;
    const text = raw.slice(i, end);
    let term = 0;
    if (end < raw.length) term = raw[end] === "\r" && raw[end + 1] === "\n" ? 2 : 1;
    lines.push({ text, srcStart: cursor, srcLen: text.length + term });
    cursor += text.length + term;
    if (end >= raw.length) break;
    i = end + term;
  }

  const out: string[] = [];
  let mdLen = 0;
  let blankRun = 0;
  let pendingJoin = false;

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (!line) continue;
    let text = normalizeLine(line.text);

    if (text.trim().length === 0) {
      blankRun++;
      if (blankRun > maxBlankLines) continue; // dropped: source moves on, output does not
      map.mark(mdLen, line.srcStart);
      out.push("");
      mdLen += 1;
      continue;
    }
    blankRun = 0;

    let joinNext = false;
    if (dehyphenate) {
      const next = lines[n + 1]?.text ?? "";
      if (isBrokenWord(text, next)) {
        text = text.slice(0, -1); // drop the hyphen
        joinNext = true;
      }
    }

    // A joined line's offsets are the enclosing line's, not exact — the
    // resolver reports that rather than pretending to character precision.
    map.mark(mdLen, line.srcStart);
    if (pendingJoin) {
      const prev = out.pop() ?? "";
      out.push(prev + text.trimStart());
      mdLen += text.trimStart().length;
    } else {
      out.push(text);
      mdLen += text.length + 1;
    }
    pendingJoin = joinNext;
  }

  // Trailing blank lines carry nothing.
  while (out.length > 0 && (out[out.length - 1] ?? "").trim() === "") out.pop();
  return out.join("\n");
}
