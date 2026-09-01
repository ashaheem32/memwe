import { MemweError, NormalizedDoc } from "@memwe/contracts";
import type { Logger } from "../log.js";
import { decode } from "./decode.js";
import { extractMarkdown } from "./markdown.js";
import { extractPdf } from "./pdf.js";
import { sniff } from "./sniff.js";
import { normalizeNewlines, SpanMap } from "./spans.js";

export type ExtractInput = {
  bytes: Buffer;
  declaredMime: string | null;
  filename: string | null;
};

export type ExtractOutput = {
  doc: NormalizedDoc;
  /** Everything worth logging or storing about how extraction went. */
  stats: Record<string, unknown>;
};

/**
 * Route bytes to an extractor and emit a NormalizedDoc.
 *
 * Adding a format means adding a branch here and nothing else — chunking,
 * embedding and distillation only ever see NormalizedDoc.
 */
export async function extract(input: ExtractInput, log: Logger): Promise<ExtractOutput> {
  const detected = await sniff(input.bytes, input.declaredMime, input.filename);
  if (detected.declaredMismatch) {
    log.warn("declared content type does not match the bytes", {
      declared: detected.declaredMismatch,
      actual: detected.mime,
    });
  }

  if (detected.kind === "unsupported") {
    // Fail the document, not the batch, and never retry — the bytes will
    // not become supported on a second attempt.
    throw new MemweError("unsupported_content", `cannot extract ${detected.mime}`, {
      mime: detected.mime,
    });
  }

  if (detected.kind === "pdf") {
    const r = await extractPdf(input.bytes, log);
    const doc = NormalizedDoc.parse({
      title: r.title ?? input.filename ?? null,
      markdown: r.markdown,
      spanMap: r.spanMap.toJSON(),
      sections: [],
      mime: detected.mime,
    });
    return {
      doc,
      stats: {
        format: "pdf",
        pages: r.pages,
        ocrPages: r.ocrPages.length,
        ocrSkipped: r.ocrSkipped,
        meanOcrConfidence: r.meanOcrConfidence === null ? null : Math.round(r.meanOcrConfidence),
        spanMapTruncatedAt: r.spanMap.truncated,
        chars: r.markdown.length,
      },
    };
  }

  const { text, encoding, bomStripped } = decode(input.bytes);
  const map = new SpanMap();
  const markdown = normalizeNewlines(text, map, bomStripped ? 3 : 0);

  if (markdown.trim().length === 0) {
    throw new MemweError("unsupported_content", "document is empty after decoding");
  }

  const isMarkdown = detected.kind === "markdown";
  const { sections, title } = isMarkdown
    ? extractMarkdown(markdown)
    : { sections: [], title: null };

  const doc = NormalizedDoc.parse({
    title: title ?? input.filename ?? null,
    markdown,
    spanMap: map.toJSON(),
    sections,
    mime: detected.mime,
  });

  return {
    doc,
    stats: {
      format: detected.kind,
      encoding,
      bomStripped,
      sections: sections.length,
      spanMapTruncatedAt: map.truncated,
      chars: markdown.length,
    },
  };
}
