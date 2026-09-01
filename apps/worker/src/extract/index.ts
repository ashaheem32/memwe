import type { Acl, TrustTier } from "@memwe/contracts";
import { MemweError, NormalizedDoc } from "@memwe/contracts";
import type { Logger } from "../log.js";
import { decode } from "./decode.js";
import { extractMarkdown } from "./markdown.js";
import { normalizeText } from "./normalize.js";
import { extractPdf } from "./pdf.js";
import { sniff } from "./sniff.js";
import { SpanMap } from "./spans.js";

export type ExtractInput = {
  bytes: Buffer;
  declaredMime: string | null;
  filename: string | null;
  /**
   * Everything the document row already knows. Extraction does not invent
   * these — it carries them through, because a NormalizedDoc that drops the
   * ACL or the trust tier quietly breaks the two rules that depend on them:
   * ACL intersection on distilled memories, and never treating untrusted
   * text as an instruction.
   */
  sourceUri?: string | null;
  acl?: Acl;
  trust?: TrustTier;
  occurredAt?: string | null;
  participants?: string[];
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

  const carried = {
    sourceUri: input.sourceUri ?? null,
    occurredAt: input.occurredAt ?? null,
    participants: input.participants ?? [],
    ...(input.acl ? { acl: input.acl } : {}),
    ...(input.trust ? { trust: input.trust } : {}),
  };

  if (detected.kind === "pdf") {
    const r = await extractPdf(input.bytes, log);
    const doc = NormalizedDoc.parse({
      ...carried,
      title: r.title ?? input.filename ?? null,
      markdown: r.markdown,
      spanMap: r.spanMap.toJSON(),
      sections: r.sections,
      mime: detected.mime,
    });
    return {
      doc,
      stats: {
        format: "pdf",
        pages: r.pages,
        headings: r.headings,
        ocrPages: r.ocrPages.length,
        ocrSkipped: r.ocrSkipped,
        runningHeadsRemoved: r.runningHeads.length,
        meanOcrConfidence: r.meanOcrConfidence === null ? null : Math.round(r.meanOcrConfidence),
        spanSegments: r.spanMap.toJSON().length,
        spanMapTruncatedAt: r.spanMap.truncated,
        chars: r.markdown.length,
      },
    };
  }

  const { text, encoding, bomStripped } = decode(input.bytes);
  const map = new SpanMap();
  // Markdown is authored, so its line breaks are meaningful and a trailing
  // hyphen is a real one. Only PDFs get de-hyphenated.
  const markdown = normalizeText(text, map, bomStripped ? 3 : 0, { dehyphenate: false });

  if (markdown.trim().length === 0) {
    throw new MemweError("unsupported_content", "document is empty after decoding");
  }

  const isMarkdown = detected.kind === "markdown";
  const { sections, title } = isMarkdown
    ? extractMarkdown(markdown)
    : { sections: [], title: null };

  const doc = NormalizedDoc.parse({
    ...carried,
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
      spanSegments: map.toJSON().length,
      spanMapTruncatedAt: map.truncated,
      chars: markdown.length,
    },
  };
}

export { resolveSpan } from "./spans.js";
