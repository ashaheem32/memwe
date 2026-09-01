import { MemweError } from "@memwe/contracts";
import * as mupdf from "mupdf";
import type { Logger } from "../log.js";
import { ocr } from "./ocr.js";
import { SpanMap } from "./spans.js";

/**
 * Read per call, not at module load. Reading env once at import time makes
 * the behaviour untestable without re-importing the module, and makes a
 * deployment override depend on import order.
 */
function config() {
  return {
    maxPages: Number(process.env["PDF_MAX_PAGES"] ?? 500),
    ocrEnabled: process.env["OCR_ENABLED"] !== "false",
    /** A page with fewer real characters than this is treated as an image. */
    ocrMinChars: Number(process.env["PDF_OCR_MIN_CHARS"] ?? 16),
    ocrMaxPages: Number(process.env["PDF_OCR_MAX_PAGES"] ?? 20),
    ocrDpi: Number(process.env["PDF_OCR_DPI"] ?? 200),
  };
}

export type PdfResult = {
  markdown: string;
  spanMap: SpanMap;
  title: string | null;
  pages: number;
  ocrPages: number[];
  /** Pages that needed OCR but did not get it. Never truncate silently. */
  ocrSkipped: number[];
  meanOcrConfidence: number | null;
};

type StructuredText = { blocks?: Array<{ lines?: Array<{ text?: string }> }> };

function pageText(page: mupdf.PDFPage): string {
  const st = JSON.parse(page.toStructuredText("preserve-whitespace").asJSON()) as StructuredText;
  return (st.blocks ?? [])
    .map((b) => (b.lines ?? []).map((l) => l.text ?? "").join("\n"))
    .filter((s) => s.length > 0)
    .join("\n\n");
}

function renderPng(page: mupdf.PDFPage, dpi: number): Buffer {
  const scale = dpi / 72;
  const pix = page.toPixmap(
    mupdf.Matrix.scale(scale, scale),
    mupdf.ColorSpace.DeviceGray,
    false,
    true,
  );
  return Buffer.from(pix.asPNG());
}

/**
 * Text layer first, OCR only where there isn't one.
 *
 * The decision is per page, not per document, because mixed documents are
 * common — a digital report with a scanned signature page. Deciding once
 * for the whole file either wastes OCR on text pages or misses the scanned
 * ones entirely.
 */
export async function extractPdf(bytes: Buffer, log: Logger): Promise<PdfResult> {
  const cfg = config();
  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(bytes, "application/pdf");
  } catch (err) {
    throw new MemweError("unsupported_content", `not a readable PDF: ${String(err)}`);
  }

  const total = doc.countPages();
  if (total === 0) throw new MemweError("unsupported_content", "PDF has no pages");
  const pages = Math.min(total, cfg.maxPages);
  if (total > pages) log.warn("pdf truncated", { total, kept: pages, limit: cfg.maxPages });

  const spanMap = new SpanMap();
  const parts: string[] = [];
  const ocrPages: number[] = [];
  const ocrSkipped: number[] = [];
  const confidences: number[] = [];
  let md = 0;

  for (let i = 0; i < pages; i++) {
    const page = doc.loadPage(i) as mupdf.PDFPage;
    let text = pageText(page).trim();
    let src = 0;

    if (text.length < cfg.ocrMinChars) {
      if (!cfg.ocrEnabled) {
        ocrSkipped.push(i + 1);
      } else if (ocrPages.length >= cfg.ocrMaxPages) {
        ocrSkipped.push(i + 1);
      } else {
        const started = Date.now();
        const result = await ocr().recognize(renderPng(page, cfg.ocrDpi));
        text = result.text.trim();
        confidences.push(result.confidence);
        ocrPages.push(i + 1);
        log.debug("ocr page", {
          page: i + 1,
          ms: Date.now() - started,
          confidence: Math.round(result.confidence),
          chars: text.length,
        });
      }
    }

    if (text.length === 0) continue;

    // Offsets are into this page's extracted text — a character offset into
    // raw PDF bytes would be meaningless.
    spanMap.mark(md, src, i + 1);
    src += text.length;
    parts.push(text);
    md += text.length + 2; // the "\n\n" join
  }

  if (ocrSkipped.length > 0) {
    log.warn("pages needed OCR but were skipped", {
      pages: ocrSkipped,
      reason: cfg.ocrEnabled ? `cap of ${cfg.ocrMaxPages} reached` : "OCR_ENABLED=false",
    });
  }

  const markdown = parts.join("\n\n");
  if (markdown.trim().length === 0) {
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

  return {
    markdown,
    spanMap,
    title,
    pages,
    ocrPages,
    ocrSkipped,
    meanOcrConfidence:
      confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null,
  };
}
