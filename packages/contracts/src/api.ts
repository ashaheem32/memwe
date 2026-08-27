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
  token_count: z.number().int().nullable(),
  stage_error: z.string().nullable(),
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
    customId: z.string().max(255).optional(),
  })
  .meta({ id: "UploadRequest" });

export const UploadResponse = z
  .object({
    id: z.guid(),
    /** PUT the bytes here directly. They never pass through the API. */
    uploadUrl: z.string(),
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
