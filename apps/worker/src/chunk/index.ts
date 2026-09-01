import type { NormalizedDoc } from "@memwe/contracts";
import type { Logger } from "../log.js";
import { type Block, toBlocks } from "./blocks.js";
import { tokens } from "./tokens.js";

export type Chunk = {
  ord: number;
  text: string;
  /** Enclosing headings, outermost first. Becomes the chunk's context header. */
  path: string[];
  /** Offsets into the document markdown — resolve through the span map for source. */
  spanStart: number;
  spanEnd: number;
  tokenCount: number;
  /** Tokens carried over from the previous chunk. Zero at a heading boundary. */
  overlapTokens: number;
};

export type ChunkOptions = {
  /** Where chunks should land. */
  target?: number;
  /** Hard ceiling; a block larger than this gets split. */
  max?: number;
  /**
   * Below this, a chunk is too small to embed usefully, so a heading
   * boundary is not worth honouring.
   */
  min?: number;
  /** Fraction of `target` carried into the next chunk at a budget split. */
  overlap?: number;
};

function config(opts: ChunkOptions) {
  const target = opts.target ?? Number(process.env["CHUNK_TARGET_TOKENS"] ?? 600);
  return {
    target,
    max: opts.max ?? Number(process.env["CHUNK_MAX_TOKENS"] ?? Math.round(target * 1.35)),
    min: opts.min ?? Number(process.env["CHUNK_MIN_TOKENS"] ?? 120),
    overlap: opts.overlap ?? Number(process.env["CHUNK_OVERLAP"] ?? 0.12),
  };
}

const SENTENCE = /(?<=[.!?])\s+/;

/** Deepest heading path shared by every block in a chunk. */
function commonPrefix(paths: string[][]): string[] {
  const first = paths[0];
  if (!first) return [];
  let n = first.length;
  for (const path of paths) {
    let i = 0;
    while (i < n && i < path.length && path[i] === first[i]) i++;
    n = i;
    if (n === 0) break;
  }
  return first.slice(0, n);
}

/**
 * A block bigger than the ceiling has to be broken somewhere. Prefer
 * sentence boundaries; fall back to lines for code, where sentences do not
 * exist; hard-split only as a last resort, and say so.
 */
function splitOversized(block: Block, max: number, log: Logger): Block[] {
  const pieces: Block[] = [];

  // A fence too large to keep whole still has to stay valid markdown. Strip
  // the delimiters, split the body, then re-wrap each piece — otherwise the
  // halves carry one ``` each and render as broken text.
  let fenceOpen: string | null = null;
  let fenceClose = "";
  let body = block.text;
  if (block.type === "code") {
    const lines = block.text.split("\n");
    const first = lines[0] ?? "";
    if (/^\s{0,3}(`{3,}|~{3,})/.test(first)) {
      fenceOpen = first;
      const last = lines[lines.length - 1] ?? "";
      const closes = /^\s{0,3}(`{3,}|~{3,})\s*$/.test(last);
      fenceClose = closes ? last : (first.match(/`{3,}|~{3,}/)?.[0] ?? "```");
      body = lines.slice(1, closes ? -1 : undefined).join("\n");
    }
  }

  const units =
    block.type === "code" || block.type === "table"
      ? body.split("\n").map((t) => `${t}\n`)
      : body.split(SENTENCE).map((t) => `${t} `);

  let buf = "";
  let start = block.start;
  const wrap = (t: string) => (fenceOpen ? `${fenceOpen}\n${t}\n${fenceClose}` : t);

  const flush = () => {
    if (buf.length === 0) return;
    pieces.push({
      ...block,
      text: wrap(buf.trimEnd()),
      start,
      end: start + buf.length,
    });
    start += buf.length;
    buf = "";
  };

  for (const unit of units) {
    if (tokens.count(unit) > max) {
      // A single sentence or line over the ceiling. Truncation would lose
      // content silently, so split on the token boundary instead.
      flush();
      let rest = unit;
      while (tokens.count(rest) > max) {
        const head = tokens.truncate(rest, max);
        pieces.push({ ...block, text: wrap(head), start, end: start + head.length });
        start += head.length;
        rest = rest.slice(head.length);
      }
      buf = rest;
      continue;
    }
    if (buf.length > 0 && tokens.count(buf + unit) > max) flush();
    buf += unit;
  }
  flush();

  log.warn("oversized block split", {
    type: block.type,
    tokens: tokens.count(block.text),
    max,
    pieces: pieces.length,
  });
  return pieces;
}

/** Trailing sentences of `text` totalling at most `budget` tokens. */
function tail(text: string, budget: number): string {
  const sentences = text.split(SENTENCE);
  const taken: string[] = [];
  let used = 0;
  for (let i = sentences.length - 1; i >= 0; i--) {
    const s = sentences[i];
    if (!s) continue;
    const n = tokens.count(s);
    if (used + n > budget) break;
    taken.unshift(s);
    used += n;
  }
  return taken.join(" ");
}

/**
 * Structure first, budget second.
 *
 * Chunks split on the section tree and are packed to roughly `target`
 * tokens. Two rules do most of the work:
 *
 *  - A heading is a real boundary, so a chunk never crosses one — unless
 *    what it has accumulated is too small to embed usefully, in which case
 *    a heading with one line under it merges forward rather than becoming
 *    a 15-token chunk that matches everything and means nothing.
 *
 *  - Overlap exists to avoid losing context at an arbitrary cut. A heading
 *    is not an arbitrary cut, so overlap is applied at budget splits only.
 */
export function chunkDocument(doc: NormalizedDoc, log: Logger, opts: ChunkOptions = {}): Chunk[] {
  const cfg = config(opts);
  const overlapBudget = Math.round(cfg.target * cfg.overlap);

  const blocks: Block[] = [];
  for (const block of toBlocks(doc.markdown)) {
    if (tokens.count(block.text) > cfg.max) {
      blocks.push(...splitOversized(block, cfg.max, log));
    } else {
      blocks.push(block);
    }
  }

  const chunks: Chunk[] = [];
  let buf: Block[] = [];
  let bufTokens = 0;
  let carry = "";
  let carryTokens = 0;

  const samePath = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  const flush = (reason: "budget" | "heading" | "end"): void => {
    if (buf.length === 0) return;
    const first = buf[0];
    const last = buf[buf.length - 1];
    if (!first || !last) return;

    const body = buf.map((b) => b.text).join("\n\n");
    const text = carry.length > 0 ? `${carry}\n\n${body}` : body;

    // A trailing remainder too small to stand alone belongs on the previous
    // chunk. Emitting it would leave a 26-token chunk that matches loosely
    // and carries almost no meaning — the same reason a tiny section merges
    // forward, applied at the end where there is nothing to merge into.
    const previous = chunks[chunks.length - 1];
    if (reason === "end" && previous !== undefined) {
      const bodyTokens = tokens.count(body);
      if (bodyTokens < cfg.min && previous.tokenCount + bodyTokens <= cfg.max) {
        previous.text = `${previous.text}\n\n${body}`;
        previous.tokenCount = tokens.count(previous.text);
        previous.spanEnd = last.end;
        buf = [];
        bufTokens = 0;
        return;
      }
    }

    chunks.push({
      ord: chunks.length,
      text,
      // The deepest heading path shared by the chunk's *content*. Headings
      // are excluded because a chunk that opens with the document title
      // would otherwise be labelled with the title alone, losing the
      // section its text actually sits in. When a chunk merged sibling
      // sections, this still lands on the parent they share.
      path: commonPrefix(
        (buf.some((b) => b.type !== "heading") ? buf.filter((b) => b.type !== "heading") : buf).map(
          (b) => b.path,
        ),
      ),
      spanStart: first.start,
      spanEnd: last.end,
      tokenCount: tokens.count(text),
      overlapTokens: carryTokens,
    });

    if (reason === "budget") {
      carry = tail(body, overlapBudget);
      carryTokens = carry.length > 0 ? tokens.count(carry) : 0;
    } else {
      carry = "";
      carryTokens = 0;
    }
    buf = [];
    bufTokens = 0;
  };

  for (const block of blocks) {
    const prev = buf[buf.length - 1];
    const headingChanged = prev !== undefined && !samePath(prev.path, block.path);

    // Honour a heading boundary only if what we have is worth emitting.
    if (headingChanged && bufTokens >= cfg.min) flush("heading");

    const blockTokens = tokens.count(block.text);
    if (buf.length > 0 && bufTokens + carryTokens + blockTokens > cfg.max) flush("budget");

    buf.push(block);
    bufTokens += blockTokens;

    if (bufTokens + carryTokens >= cfg.target) flush("budget");
  }
  flush("end");

  return chunks;
}

/**
 * The chunk's context header. For now this is the heading path, which is
 * deterministic and free. Sprint 2 replaces it with a generated situating
 * sentence — the single highest-leverage retrieval upgrade available — and
 * this stays as the fallback for documents with no headings.
 */
export function contextHeader(doc: NormalizedDoc, chunk: Chunk): string | null {
  const parts = [doc.title, ...chunk.path].filter((p): p is string => Boolean(p));
  const unique = parts.filter((p, i) => parts.indexOf(p) === i);
  return unique.length > 0 ? unique.join(" › ") : null;
}

export { warmTokenizer } from "./tokens.js";
