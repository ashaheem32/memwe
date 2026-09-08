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
  authoredMarkdown?: boolean;
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

  let out = "";
  let blankRun = 0;
  let pendingJoin = false;
  let fence: { char: string; length: number } | null = null;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
    const inCode = opts.authoredMarkdown && (fence !== null || marker !== null);
    if (opts.authoredMarkdown && marker?.[1]) {
      if (!fence) fence = { char: marker[1][0]!, length: marker[1].length };
      else if (
        marker[1][0] === fence.char &&
        marker[1].length >= fence.length &&
        !marker[2]?.trim()
      )
        fence = null;
    }
    let text = inCode ? line.text : normalizeLine(line.text);
    if (opts.authoredMarkdown && !inCode && / {2,}$/.test(line.text)) text += "  ";
    if (!inCode && !text.trim()) {
      blankRun++;
      if (blankRun > maxBlankLines) continue;
    } else blankRun = 0;
    let joinNext = false;
    if (dehyphenate && !inCode && isBrokenWord(text, lines[n + 1]?.text ?? "")) {
      text = text.slice(0, -1);
      joinNext = true;
    }
    if (pendingJoin) text = text.trimStart();
    else if (n > 0 && out.length > 0) out += "\n";
    const start = out.length;
    out += text;
    const exact = text === line.text && !pendingJoin && !joinNext;
    map.mark(start, line.srcStart, {
      mdEnd: out.length,
      srcEnd: line.srcStart + line.text.length,
      exact,
    });
    pendingJoin = joinNext;
  }
  return out.replace(/\n+$/, "");
}
