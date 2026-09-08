import type { Section } from "@memwe/contracts";
import { MemweError } from "@memwe/contracts";
import * as mupdf from "mupdf";
import type { Logger } from "../log.js";
import { isBrokenWord, normalizeLine } from "./normalize.js";
import { ocr } from "./ocr.js";
import { SpanMap } from "./spans.js";

/**
 * Read per call, not at module load. Reading env once at import time makes
 * the behaviour untestable without re-importing the module, and makes a
 * deployment override depend on import order.
 */
function config() {
  return {
    maxPages: Number(process.env.PDF_MAX_PAGES ?? 500),
    ocrEnabled: process.env.OCR_ENABLED !== "false",
    /** A page with fewer real characters than this is treated as an image. */
    ocrMinChars: Number(process.env.PDF_OCR_MIN_CHARS ?? 16),
    ocrMaxPages: Number(process.env.PDF_OCR_MAX_PAGES ?? 20),
    ocrDpi: Number(process.env.PDF_OCR_DPI ?? 200),
    /** A line this much larger than body text is a heading. */
    headingRatio: Number(process.env.PDF_HEADING_RATIO ?? 1.15),
  };
}

export type PdfResult = {
  markdown: string;
  spanMap: SpanMap;
  sections: Section[];
  title: string | null;
  pages: number;
  totalPages: number;
  ocrPages: number[];
  /** Pages that needed OCR but did not get it. Never truncate silently. */
  ocrSkipped: number[];
  runningHeads: string[];
  headings: number;
  meanOcrConfidence: number | null;
};

type Line = { text: string; size: number; bold: boolean; bbox: [number, number, number, number] };

type StructuredText = {
  blocks?: Array<{
    lines?: Array<{
      text?: string;
      bbox?: { x: number; y: number; w: number; h: number };
      font?: { size?: number; weight?: string };
    }>;
  }>;
};

function pageLines(page: mupdf.PDFPage): Line[] {
  const structured = page.toStructuredText("preserve-whitespace");
  let st: StructuredText;
  try {
    st = JSON.parse(structured.asJSON()) as StructuredText;
  } finally {
    structured.destroy();
  }
  const out: Line[] = [];
  for (const block of st.blocks ?? []) {
    for (const line of block.lines ?? []) {
      const text = (line.text ?? "").trim();
      if (text.length === 0) continue;
      const b = line.bbox;
      out.push({
        text,
        size: line.font?.size ?? 0,
        bold: (line.font?.weight ?? "normal") === "bold",
        bbox: b ? [b.x, b.y, b.w, b.h] : [0, 0, 0, 0],
      });
    }
  }
  return out;
}

function renderPng(page: mupdf.PDFPage, dpi: number): Buffer {
  const scale = dpi / 72;
  const pix = page.toPixmap(
    mupdf.Matrix.scale(scale, scale),
    mupdf.ColorSpace.DeviceGray,
    false,
    true,
  );
  try {
    return Buffer.from(pix.asPNG());
  } finally {
    pix.destroy();
  }
}

/** Bare page numbers and "Page 3 of 12" carry nothing into a memory. */
const PAGE_NUMBER = /^(page\s+)?\d+(\s*\/\s*\d+|\s+of\s+\d+)?$/i;

/**
 * Running heads repeat on most pages and would otherwise appear in every
 * chunk, diluting the embedding of each one with the document's title.
 */
function findRunningHeads(pages: Line[][]): Set<string> {
  const found = new Set<string>();
  if (pages.length < 3) return found;

  const counts = new Map<string, number>();
  for (const lines of pages) {
    const edges = [lines[0], lines[1], lines[lines.length - 2], lines[lines.length - 1]];
    const pageKeys = new Set<string>();
    for (const line of edges) {
      if (!line) continue;
      const key = line.text.replace(/\d+/g, "#").toLowerCase();
      pageKeys.add(key);
    }
    for (const key of pageKeys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const threshold = Math.ceil(pages.length * 0.6);
  for (const [key, n] of counts) if (n >= threshold) found.add(key);
  return found;
}

function isRunningHead(line: Line, heads: Set<string>): boolean {
  if (PAGE_NUMBER.test(line.text)) return true;
  return heads.has(line.text.replace(/\d+/g, "#").toLowerCase());
}

/**
 * PDFs have no headings, only text that is bigger. Ranking the distinct
 * larger-than-body sizes recovers a usable hierarchy, which is what gives
 * chunking something structural to split on instead of a token count alone.
 */
function headingLevels(pages: Line[][], ratio: number): Map<number, number> {
  const sizes = pages
    .flat()
    .map((l) => l.size)
    .filter((s) => s > 0)
    .sort((a, b) => a - b);
  const levels = new Map<number, number>();
  if (sizes.length === 0) return levels;

  const body = sizes[Math.floor(sizes.length / 2)] ?? 0;
  const bigger = [...new Set(sizes.filter((s) => s > body * ratio))].sort((a, b) => b - a);
  for (const [i, size] of bigger.entries()) levels.set(size, Math.min(i + 1, 6));
  return levels;
}

/**
 * Text layer first, OCR only where there isn't one.
 *
 * The decision is per page, not per document, because mixed documents are
 * common — a digital report with a scanned signature page. Deciding once for
 * the whole file either wastes OCR on text pages or misses the scanned ones.
 */
export async function extractPdf(bytes: Buffer, log: Logger): Promise<PdfResult> {
  const cfg = config();
  for (const [name, value] of Object.entries({
    maxPages: cfg.maxPages,
    ocrMinChars: cfg.ocrMinChars,
    ocrMaxPages: cfg.ocrMaxPages,
    ocrDpi: cfg.ocrDpi,
  })) {
    if (!Number.isInteger(value) || value <= 0)
      throw new MemweError("invalid_request", `invalid PDF setting ${name}`);
  }
  if (!Number.isFinite(cfg.headingRatio) || cfg.headingRatio <= 1)
    throw new MemweError("invalid_request", "invalid PDF heading ratio");
  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(bytes, "application/pdf");
  } catch (err) {
    throw new MemweError("unsupported_content", `not a readable PDF: ${String(err)}`);
  }

  try {
    const total = doc.countPages();
    if (total === 0) throw new MemweError("unsupported_content", "PDF has no pages");
    const pageCount = Math.min(total, cfg.maxPages);
    if (total > pageCount) {
      log.warn("pdf truncated", { total, kept: pageCount, limit: cfg.maxPages });
    }

    // Pass one: get every page's lines, OCR-ing the ones with no text layer.
    const perPage: Line[][] = [];
    const ocrPages: number[] = [];
    const ocrSkipped: number[] = [];
    const confidences: number[] = [];

    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i) as mupdf.PDFPage;
      let lines = pageLines(page);
      const chars = lines.reduce((n, l) => n + l.text.length, 0);

      if (chars < cfg.ocrMinChars) {
        if (!cfg.ocrEnabled || ocrPages.length >= cfg.ocrMaxPages) {
          ocrSkipped.push(i + 1);
        } else {
          const started = Date.now();
          const result = await ocr().recognize(renderPng(page, cfg.ocrDpi));
          confidences.push(result.confidence);
          ocrPages.push(i + 1);
          // OCR gives no geometry or font, so these lines carry page-level
          // provenance only — which the resolver reports honestly.
          lines = result.text
            .split("\n")
            .map((t) => t.trim())
            .filter((t) => t.length > 0)
            .map((text) => ({ text, size: 0, bold: false, bbox: [0, 0, 0, 0] as Line["bbox"] }));
          log.debug("ocr page", {
            page: i + 1,
            ms: Date.now() - started,
            confidence: Math.round(result.confidence),
            lines: lines.length,
          });
        }
      }
      perPage.push(lines);
      page.destroy();
    }

    if (ocrSkipped.length > 0) {
      log.warn("pages needed OCR but were skipped", {
        pages: ocrSkipped,
        reason: cfg.ocrEnabled ? `cap of ${cfg.ocrMaxPages} reached` : "OCR_ENABLED=false",
      });
    }

    // Pass two: strip running heads, promote big text to headings, and build
    // the markdown while recording where every line came from.
    //
    // Normalization happens *in this loop*, not afterwards. Running it as a
    // separate pass would shift every offset after a de-hyphenated join and
    // leave the span map pointing at the wrong characters — silently, because
    // both halves would still look correct on their own.
    const heads = findRunningHeads(perPage);
    const levels = headingLevels(perPage, cfg.headingRatio);
    const spanMap = new SpanMap();
    const sections: Section[] = [];
    const parts: string[] = [];
    let md = 0;
    let headingCount = 0;

    // Flatten first so de-hyphenation can see the following line even when it
    // is on the next page.
    type Item = {
      text: string;
      level: number | undefined;
      page: number;
      src: number;
      srcEnd: number;
      bbox: Line["bbox"];
    };
    const items: Item[] = [];
    for (let p = 0; p < perPage.length; p++) {
      let src = 0; // offset within this page's extracted text
      const pageLines = perPage[p] ?? [];
      for (const [lineIndex, line] of pageLines.entries()) {
        const lineSrc = src;
        src += line.text.length + 1;
        if ((lineIndex < 2 || lineIndex >= pageLines.length - 2) && isRunningHead(line, heads))
          continue;
        items.push({
          text: normalizeLine(line.text),
          level: levels.get(line.size),
          page: p + 1,
          src: lineSrc,
          srcEnd: lineSrc + line.text.length,
          bbox: line.bbox,
        });
      }
    }

    let pendingJoin = false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      let text = item.text;
      if (text.length === 0) continue;

      let joinNext = false;
      if (!item.level && isBrokenWord(text, items[i + 1]?.text ?? "")) {
        text = text.slice(0, -1);
        joinNext = true;
      }

      if (parts.length > 0 && !pendingJoin) {
        parts.push("\n");
        md++;
      }
      const rendered = item.level ? `${"#".repeat(item.level)} ${text}` : text;
      if (item.level) {
        sections.push({ heading: text, level: item.level, start: md, end: md });
        headingCount++;
      }
      const hasGeometry = item.bbox.some((v) => v !== 0);
      spanMap.mark(md, item.src, {
        page: item.page,
        mdEnd: md + rendered.length,
        srcEnd: item.srcEnd,
        exact:
          hasGeometry &&
          !item.level &&
          !pendingJoin &&
          !joinNext &&
          rendered.length === item.srcEnd - item.src,
        ...(hasGeometry ? { bbox: item.bbox } : {}),
      });
      parts.push(rendered);
      md += rendered.length;
      pendingJoin = joinNext;
    }

    // Close each section at the next same-or-higher heading.
    for (let i = 0; i < sections.length; i++) {
      const current = sections[i];
      if (!current) continue;
      const next = sections.slice(i + 1).find((s) => s.level <= current.level);
      current.end = next ? next.start : md;
    }

    const normalized = parts.join("");
    if (normalized.trim().length === 0) {
      throw new MemweError(
        "unsupported_content",
        cfg.ocrEnabled
          ? "PDF produced no text, with or without OCR"
          : "PDF has no text layer and OCR is disabled",
      );
    }

    let title: string | null = null;
    try {
      title = (doc as mupdf.PDFDocument).getMetaData("info:Title")?.trim() || null;
    } catch {
      title = null;
    }
    title ??= sections.find((s) => s.level === 1)?.heading ?? null;

    return {
      markdown: normalized,
      spanMap,
      sections,
      title,
      pages: pageCount,
      totalPages: total,
      ocrPages,
      ocrSkipped,
      runningHeads: [...heads],
      headings: headingCount,
      meanOcrConfidence:
        confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null,
    };
  } finally {
    doc.destroy();
  }
}
