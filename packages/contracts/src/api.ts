import { z } from "zod";
import { DocStatus, IngestRequest } from "./normalized-doc.js";
import { ContainerTag } from "./tenant.js";

/**
 * Response shapes. These live in contracts, not in the route files,
 * because the SDKs, the docs site and the MCP tool definitions are all
 * generated from the OpenAPI document that derives from them. A response
 * shape that only exists inside a handler cannot be generated from.
 */

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
    }),
    traceId: z.string().optional(),
  })
  .meta({ id: "ErrorResponse" });

export const IngestResponse = z
  .object({
    id: z.guid(),
    status: DocStatus,
    /** True when content-hash dedupe matched — nothing was re-processed or re-billed. */
    deduped: z.boolean(),
    /**
     * Bumped when a customId was re-ingested with different content. The id
     * is stable across revisions; that is what customId is for.
     */
    revision: z.number().int().positive().default(1),
    /** True when this call replaced the stored content and restarted the pipeline. */
    revised: z.boolean().default(false),
  })
  .meta({ id: "IngestResponse" });

export const DocumentSummary = z
  .object({
    id: z.guid(),
    container: ContainerTag,
    title: z.string().nullable(),
    status: DocStatus,
    created_at: z.union([z.string(), z.date()]),
  })
  .meta({ id: "DocumentSummary" });

/**
 * What the last revision changed, counted in chunks. A chunk is the same
 * chunk when its text and heading path are unchanged; it then keeps its
 * row, context and vector and only moves. `from` is null for revision 1.
 */
export const RevisionDiff = z
  .object({
    from: z.number().int().positive().nullable(),
    to: z.number().int().positive(),
    kept: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    /** Kept chunks whose position changed. */
    moved: z.number().int().nonnegative(),
  })
  .meta({ id: "RevisionDiff" });
export type RevisionDiff = z.infer<typeof RevisionDiff>;

export const DocumentDetail = DocumentSummary.extend({
  extraction: z.record(z.string(), z.unknown()).nullable().optional(),
  /** Chunk-level diff of the current revision against the previous one. */
  diff: RevisionDiff.nullable().optional(),
  token_count: z.number().int().nullable(),
  stage_error: z.string().nullable(),
  /** Which pipeline stage failed. Null unless status is `failed`. */
  failed_stage: z.string().nullable(),
  /**
   * Set when these bytes were already stored under another id. The document
   * is kept rather than rejected — the caller holds this id — and carries its own derived content. This pointer records dedupe provenance;
   * it is not a redirect, because either document may later be revised.
   */
  duplicate_of: z.guid().nullable(),
  /** Bumped when a customId was re-ingested with different content. */
  revision: z.number().int().positive(),
  /** When the document last moved stage — the answer to "is it stuck?". */
  status_changed_at: z.union([z.string(), z.date()]).nullable(),
  /** 0..1 position through the pipeline, so a caller need not know the stages. */
  progress: z.number().min(0).max(1),
  updated_at: z.union([z.string(), z.date()]),
}).meta({ id: "DocumentDetail" });

export const DocumentList = z
  .object({ documents: z.array(DocumentSummary) })
  .meta({ id: "DocumentList" });

export const UploadRequest = z
  .object({
    container: ContainerTag,
    filename: z.string().min(1).max(500),
    contentType: z.string().min(1).max(255),
    customId: z.string().min(1).max(255).optional(),
  })
  .meta({ id: "UploadRequest" });

export const UploadResponse = z
  .object({
    id: z.guid(),
    /** PUT the bytes here directly. They never pass through the API. */
    uploadUrl: z.string(),
    /** Pass as ?revision=N when completing the upload. */
    revision: z.number().int().positive().default(1),
    expiresInSeconds: z.number().int(),
  })
  .meta({ id: "UploadResponse" });

export const HealthResponse = z
  .object({
    ok: z.boolean(),
    postgres: z.boolean(),
    redis: z.boolean(),
  })
  .meta({ id: "HealthResponse" });

export type IngestResponse = z.infer<typeof IngestResponse>;

export const BATCH_MAX_ITEMS = 100;

/**
 * Many documents in one request. Items are processed in order, each in its
 * own transaction, so an item can fail without undoing the ones before it
 * and two identical items dedupe against each other. The envelope is
 * validated as a whole: a malformed item is a 400 for the request, since
 * that is a caller bug rather than a per-document outcome.
 */
export const BatchIngestRequest = z
  .object({ items: z.array(IngestRequest).min(1).max(BATCH_MAX_ITEMS) })
  .meta({ id: "BatchIngestRequest" });
export type BatchIngestRequest = z.infer<typeof BatchIngestRequest>;

export const BatchIngestItem = z
  .object({
    /** Position in `items`. Results come back in the same order. */
    index: z.number().int().nonnegative(),
    result: IngestResponse.optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  })
  .meta({ id: "BatchIngestItem" });
export type BatchIngestItem = z.infer<typeof BatchIngestItem>;

export const BatchIngestResponse = z
  .object({
    results: z.array(BatchIngestItem),
    accepted: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .meta({ id: "BatchIngestResponse" });
export type BatchIngestResponse = z.infer<typeof BatchIngestResponse>;
export type UploadResponse = z.infer<typeof UploadResponse>;
