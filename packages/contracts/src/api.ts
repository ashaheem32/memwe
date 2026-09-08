import { z } from "zod";
import { DocStatus } from "./normalized-doc.js";
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

export const DocumentDetail = DocumentSummary.extend({
  extraction: z.record(z.string(), z.unknown()).nullable().optional(),
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
export type UploadResponse = z.infer<typeof UploadResponse>;
