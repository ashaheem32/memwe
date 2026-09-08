import { MemweError, type NormalizedDoc } from "@memwe/contracts";
import type { Logger } from "../log.js";
import { type Block, toBlocks } from "./blocks.js";
import { tokens } from "./tokens.js";

/** Maps only original characters; generated separators/fences have no source range. */
export type ChunkSourceRange = {
  textStart: number;
  textEnd: number;
  spanStart: number;
  spanEnd: number;
};
export type Chunk = {
  ord: number;
  text: string;
  path: string[];
  spanStart: number;
  spanEnd: number;
  tokenCount: number;
  overlapTokens: number;
  sourceRanges: ChunkSourceRange[];
};
export type ChunkOptions = { target?: number; max?: number; min?: number; overlap?: number };
type Document = Pick<NormalizedDoc, "title" | "markdown" | "sections">;
type Piece = Block & { ranges: ChunkSourceRange[] };

function config(opts: ChunkOptions) {
  const target = opts.target ?? Number(process.env.CHUNK_TARGET_TOKENS ?? 600);
  const max = opts.max ?? Number(process.env.CHUNK_MAX_TOKENS ?? Math.round(target * 1.35));
  const min = opts.min ?? Number(process.env.CHUNK_MIN_TOKENS ?? Math.min(120, target));
  const overlap = opts.overlap ?? Number(process.env.CHUNK_OVERLAP ?? 0.12);
  if (
    ![target, max, min].every((n) => Number.isInteger(n) && n > 0) ||
    target > max ||
    min > max ||
    !Number.isFinite(overlap) ||
    overlap < 0 ||
    overlap >= 0.5
  ) {
    throw new MemweError("invalid_request", "invalid chunk token budgets or overlap");
  }
  return { target, max, min, overlap };
}
function commonPrefix(paths: string[][]): string[] {
  const first = paths[0] ?? [];
  return first.slice(
    0,
    first.findIndex((value, i) => paths.some((path) => path[i] !== value)) < 0
      ? first.length
      : first.findIndex((value, i) => paths.some((path) => path[i] !== value)),
  );
}
const samePath = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function piece(
  block: Block,
  text = block.text,
  start = block.start,
  prefix = "",
  suffix = "",
): Piece {
  return {
    ...block,
    text: prefix + text + suffix,
    start,
    end: start + text.length,
    ranges: text.length
      ? [
          {
            textStart: prefix.length,
            textEnd: prefix.length + text.length,
            spanStart: start,
            spanEnd: start + text.length,
          },
        ]
      : [],
  };
}
function split(block: Block, budget: number, log: Logger): Piece[] {
  if (tokens.count(block.text) <= budget) return [piece(block)];
  let body = block.text,
    sourceStart = block.start,
    prefix = "",
    suffix = "";
  if (block.type === "code") {
    const match = /^( {0,3}(?:`{3,}|~{3,})[^\n]*)\n/.exec(body);
    if (match) {
      prefix = `${match[1]}\n`;
      sourceStart += match[0].length;
      body = body.slice(match[0].length);
      const marker = match[1]!.trimStart().match(/^(`{3,}|~{3,})/)![1]!;
      const closing = new RegExp(`\\n {0,3}${marker[0]}{${marker.length},}[ \\t]*$`).exec(body);
      if (closing) body = body.slice(0, closing.index);
      suffix = `\n${marker}`;
    }
  }
  const result: Piece[] = [];
  const overhead = tokens.count(prefix + suffix) + 4;
  if (budget <= overhead)
    throw new MemweError("invalid_request", "chunk budget cannot fit code fence");
  let offset = 0;
  while (offset < body.length) {
    const rest = body.slice(offset);
    let head = tokens.truncate(rest, Math.max(1, budget - overhead));
    if (head.length < rest.length) {
      // Prefer a real source boundary without rebuilding or collapsing whitespace.
      const boundaries = [
        ...head.matchAll(
          block.type === "code" || block.type === "table" ? /\n/g : /(?<=[.!?])\s+/g,
        ),
      ];
      const end = boundaries.at(-1);
      if (end && end.index > head.length / 2) head = head.slice(0, end.index + end[0].length);
    }
    while (tokens.count(prefix + head + suffix) > budget && head.length > 0) {
      head = Array.from(head).slice(0, -1).join("");
    }
    if (!head.length)
      throw new MemweError("invalid_request", "chunk budget cannot fit one character");
    result.push(piece(block, head, sourceStart + offset, prefix, suffix));
    offset += head.length;
  }
  log.warn("oversized block split", { type: block.type, pieces: result.length });
  return result;
}
function sliceRanges(ranges: ChunkSourceRange[], start: number, end: number): ChunkSourceRange[] {
  return ranges.flatMap((r) => {
    const a = Math.max(start, r.textStart),
      b = Math.min(end, r.textEnd);
    return a < b
      ? [
          {
            textStart: a - start,
            textEnd: b - start,
            spanStart: r.spanStart + a - r.textStart,
            spanEnd: r.spanStart + b - r.textStart,
          },
        ]
      : [];
  });
}
function tail(chunk: Chunk, budget: number): { text: string; ranges: ChunkSourceRange[] } {
  if (budget <= 0) return { text: "", ranges: [] };
  let start = chunk.text.length;
  const bounds = [
    0,
    ...[...chunk.text.matchAll(/(?<=[.!?])\s+/g)].map((m) => m.index + m[0].length),
  ];
  for (let i = bounds.length - 1; i >= 0; i--) {
    const candidate = bounds[i]!;
    if (tokens.count(chunk.text.slice(candidate)) > budget) break;
    start = candidate;
  }
  // Long sentences still get overlap, on a Unicode character boundary.
  if (start === chunk.text.length) {
    let n = chunk.text.length;
    while (n > 0) {
      const previous = n - (n >= 2 && /[\uDC00-\uDFFF]/.test(chunk.text[n - 1]!) ? 2 : 1);
      if (tokens.count(chunk.text.slice(previous)) > budget) break;
      n = previous;
    }
    start = n;
  }
  return {
    text: chunk.text.slice(start),
    ranges: sliceRanges(chunk.sourceRanges, start, chunk.text.length),
  };
}
export function chunkDocument(doc: Document, log: Logger, opts: ChunkOptions = {}): Chunk[] {
  const cfg = config(opts),
    overlapBudget = Math.round(cfg.target * cfg.overlap);
  const pieces: Piece[] = [];
  for (const block of toBlocks(doc.markdown)) {
    if (doc.sections.length) {
      block.path = doc.sections
        .filter((s) => s.start <= block.start && s.end > block.start)
        .sort((a, b) => a.level - b.level)
        .map((s) => s.heading);
    }
    pieces.push(
      ...split(block, Math.max(1, Math.min(cfg.target, cfg.max) - overlapBudget - 8), log),
    );
  }
  const chunks: Chunk[] = [];
  let buf: Piece[] = [],
    carry = { text: "", ranges: [] as ChunkSourceRange[] },
    lastPath: string[] = [];
  const render = () => {
    let text = carry.text;
    const ranges = [...carry.ranges];
    for (const p of buf) {
      if (text.length) text += "\n\n";
      const offset = text.length;
      text += p.text;
      ranges.push(
        ...p.ranges.map((r) => ({
          ...r,
          textStart: r.textStart + offset,
          textEnd: r.textEnd + offset,
        })),
      );
    }
    return { text, ranges };
  };
  const flush = (reason: "budget" | "heading" | "end") => {
    if (!buf.length) return;
    const { text, ranges } = render();
    const content = buf.some((p) => p.type !== "heading")
      ? buf.filter((p) => p.type !== "heading")
      : buf;
    const path = commonPrefix(content.map((p) => p.path));
    const ownText = buf.map((p) => p.text).join("\n\n");
    const previous = chunks.at(-1);
    if (
      reason === "end" &&
      previous &&
      tokens.count(ownText) < cfg.min &&
      tokens.count(previous.text + "\n\n" + ownText) <= cfg.max
    ) {
      // Drop carried overlap when merging back into the preceding chunk.
      const ownRanges = sliceRanges(
        ranges,
        carry.text.length ? carry.text.length + 2 : 0,
        text.length,
      );
      const shift = previous.text.length + 2;
      previous.text += "\n\n" + ownText;
      previous.sourceRanges.push(
        ...ownRanges.map((r) => ({
          ...r,
          textStart: r.textStart + shift,
          textEnd: r.textEnd + shift,
        })),
      );
      previous.spanEnd = Math.max(previous.spanEnd, ...ownRanges.map((r) => r.spanEnd));
      previous.path = commonPrefix([previous.path, path]);
      previous.tokenCount = tokens.count(previous.text);
    } else {
      const chunk: Chunk = {
        ord: chunks.length,
        text,
        path,
        sourceRanges: ranges,
        spanStart: Math.min(...ranges.map((r) => r.spanStart)),
        spanEnd: Math.max(...ranges.map((r) => r.spanEnd)),
        tokenCount: tokens.count(text),
        overlapTokens: tokens.count(carry.text),
      };
      if (chunk.tokenCount > cfg.max)
        throw new MemweError("internal", "chunk exceeded hard token limit");
      chunks.push(chunk);
    }
    lastPath = buf.at(-1)!.path;
    carry =
      reason === "budget" && buf.at(-1)!.type !== "code"
        ? tail(chunks.at(-1)!, overlapBudget)
        : { text: "", ranges: [] };
    buf = [];
  };
  for (const block of pieces) {
    if (!samePath(buf.at(-1)?.path ?? lastPath, block.path)) {
      if (buf.length && tokens.count(buf.map((p) => p.text).join("\n\n")) >= cfg.min)
        flush("heading");
      carry = { text: "", ranges: [] };
    }
    buf.push(block);
    if (tokens.count(render().text) > cfg.max) {
      buf.pop();
      flush("budget");
      if (!samePath(lastPath, block.path)) carry = { text: "", ranges: [] };
      buf.push(block);
    }
    if (tokens.count(render().text) >= cfg.target) flush("budget");
  }
  flush("end");
  return chunks;
}
export function contextHeader(
  doc: Pick<NormalizedDoc, "title">,
  chunk: Pick<Chunk, "path">,
): string | null {
  const parts = [doc.title, ...chunk.path].filter((p): p is string => Boolean(p));
  return [...new Set(parts)].join(" › ") || null;
}
export { warmTokenizer } from "./tokens.js";
