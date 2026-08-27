import { z } from "zod";
import { ContainerTag } from "./tenant.js";

/**
 * THE ONE SHARED MODULE.
 *
 * Bru owns the implementation. Shaheem calls it from reconciliation to
 * find a candidate fact's existing neighbourhood — that is the single
 * real coupling between the two tracks, so it is written down here and
 * changed by agreement, not by whoever needs it that afternoon.
 */

export const SearchMode = z.enum(["memories", "chunks", "hybrid"]);
export type SearchMode = z.infer<typeof SearchMode>;

export const RetrieveParams = z.object({
  orgId: z.guid(),
  container: ContainerTag,
  query: z.string().min(1),

  mode: SearchMode.default("hybrid"),
  limit: z.number().int().min(1).max(100).default(10),
  threshold: z.number().min(0).max(1).default(0.5),

  rerank: z.boolean().default(false),
  rewriteQuery: z.boolean().default(false),

  /** Reconciliation needs these two. Nothing else should set them. */
  subject: z.string().optional(),
  includeSuperseded: z.boolean().default(false),

  /** Point-in-time read. World time, not record time. (Sprint 5+) */
  asOf: z.iso.datetime().optional(),

  filters: z.record(z.string(), z.unknown()).optional(),
  include: z
    .object({
      documents: z.boolean().default(false),
      relatedMemories: z.boolean().default(false),
      sourceSpans: z.boolean().default(false),
    })
    .optional(),
});
export type RetrieveParams = z.infer<typeof RetrieveParams>;

export type RetrieveHit = {
  id: string;
  kind: "memory" | "chunk";
  text: string;
  similarity: number;
  /** which lanes found it — a hit found by three lanes outranks one loved by one */
  lanes: string[];
  version?: number;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type RetrieveResult = {
  hits: RetrieveHit[];
  total: number;
  timingMs: number;
  /** Set by the logging middleware. Feeds Bet 01. */
  retrievalId?: string;
};

export type Retriever = (params: RetrieveParams) => Promise<RetrieveResult>;
