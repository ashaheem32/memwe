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
  /**
   * Corresponding offset in the original source. Best effort: for text and
   * markdown it is an exact byte-stream offset; for paginated formats it is
   * an offset into the extracted text of that page, because a character
   * offset into raw PDF bytes means nothing for provenance.
   */
  src: z.number().int().nonnegative(),
  /** 1-indexed source page, for formats that have pages. */
  page: z.number().int().positive().optional(),
});

export type SpanMapEntry = z.infer<typeof SpanMapEntry>;

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
   * Offsets back into the original bytes. Emit this even when it feels
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
    customId: z.string().max(255).optional(),
    title: z.string().max(500).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: "IngestRequest" });
export type IngestRequest = z.infer<typeof IngestRequest>;
