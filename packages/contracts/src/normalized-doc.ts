import { z } from "zod";
import { ContainerTag } from "./tenant.js";

/**
 * THE ENGINE'S OUTPUT CONTRACT.
 *
 * Every extractor produces this. Nothing downstream of extraction knows
 * that Notion, Gmail, or a PDF exists. Adding a connector must never mean
 * touching chunking, embedding, or distillation.
 *
 * Owner: Shaheem. Changes need Bru's signature too — the API returns
 * fields derived from this shape.
 */

export const SpanMapEntry = z.object({
  /** offset in the emitted markdown */
  md: z.number().int().nonnegative(),
  /** UTF-16 code-unit offset in decoded source (including a BOM), or PDF page text. */
  src: z.number().int().nonnegative(),
  /** Explicit bounds; required for rewritten/synthetic segments. */
  mdEnd: z.number().int().nonnegative().optional(),
  srcEnd: z.number().int().nonnegative().optional(),
  exact: z.boolean().optional(),
  /** 1-indexed source page, for formats that have pages. */
  page: z.number().int().positive().optional(),
  /** [x, y, w, h] in source units, when the format has geometry. */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});

export type SpanMapEntry = z.infer<typeof SpanMapEntry>;

/**
 * Where a range of the emitted markdown came from. This is the shape the
 * `/why` endpoint and the memory-provenance UI consume — a span map that
 * cannot be resolved back to one of these is decoration, not provenance.
 */
export const SourceLocation = z.object({
  srcStart: z.number().int().nonnegative(),
  srcEnd: z.number().int().nonnegative(),
  page: z.number().int().positive().optional(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  /**
   * False when normalization rewrote this range (de-hyphenation, ligature
   * expansion), so the offsets are the enclosing line rather than exact.
   */
  exact: z.boolean().default(true),
});
export type SourceLocation = z.infer<typeof SourceLocation>;

export const Section = z.object({
  heading: z.string(),
  level: z.number().int().min(1).max(6),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

export type Section = z.infer<typeof Section>;

export const TrustTier = z.enum(["first_party", "internal", "external", "untrusted"]);
export type TrustTier = z.infer<typeof TrustTier>;

export const Acl = z.object({
  owners: z.array(z.string()).default([]),
  readers: z.array(z.string()).default([]),
  public: z.boolean().default(false),
  source: z.string().optional(),
  syncedAt: z.iso.datetime().optional(),
});
export type Acl = z.infer<typeof Acl>;

export const NormalizedDoc = z.object({
  title: z.string().nullable(),
  markdown: z.string(),

  /**
   * Offsets into the decoded original text in UTF-16 code units. Emit this even when it feels
   * pointless — provenance and time travel are nearly free if it exists
   * and a full reprocessing job if it doesn't.
   */
  spanMap: z.array(SpanMapEntry).default([]),
  sections: z.array(Section).default([]),

  participants: z.array(z.string()).default([]),
  sourceUri: z.string().nullable().default(null),
  mime: z.string().nullable().default(null),

  /** World time — when the content is *about*, not when we ingested it. */
  occurredAt: z.iso.datetime().nullable().default(null),

  acl: Acl.default({ owners: [], readers: [], public: false }),
  trust: TrustTier.default("first_party"),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type NormalizedDoc = z.infer<typeof NormalizedDoc>;

export const DocStatus = z.enum([
  "queued",
  "extracting",
  "chunking",
  "embedding",
  "indexing",
  "done",
  "failed",
]);
export type DocStatus = z.infer<typeof DocStatus>;

export const IngestRequest = z
  .object({
    container: ContainerTag,
    content: z.string().max(1_000_000).optional(),
    url: z.url().optional(),
    customId: z.string().min(1).max(255).optional(),
    title: z.string().max(500).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: "IngestRequest" });
export type IngestRequest = z.infer<typeof IngestRequest>;
