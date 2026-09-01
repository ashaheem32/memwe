import type { DocStatus, JobType } from "@memwe/contracts";
import type { PoolClient } from "@memwe/db";

/**
 * The document status machine.
 *
 * One place, because the alternative — each stage writing its own status —
 * is how `chunking`, `embedding` and `indexing` sat unused in the enum
 * while documents reported `extracting` for the whole run.
 */

/** Pipeline order. Position in this array is what "forward" means. */
export const STATUS_ORDER: readonly DocStatus[] = [
  "queued",
  "extracting",
  "chunking",
  "embedding",
  "indexing",
  "done",
] as const;

/** Which status a stage puts the document into while it runs. */
export const STAGE_STATUS: Partial<Record<JobType, DocStatus>> = {
  "document.accept": "queued",
  "document.extract": "extracting",
  "document.chunk": "chunking",
  "document.embed": "embedding",
  "document.index": "indexing",
};

export function isTerminal(status: DocStatus): boolean {
  return status === "done" || status === "failed";
}

/** Every status a document may legally be in to move *to* `next`. */
export function allowedFrom(next: DocStatus): DocStatus[] {
  if (next === "failed") return STATUS_ORDER.filter((s) => s !== "done");
  const at = STATUS_ORDER.indexOf(next);
  if (at < 0) return [];
  // Strictly earlier only. Equal is a no-op we do not need, and later is
  // the bug this exists to prevent.
  return STATUS_ORDER.slice(0, at) as DocStatus[];
}

/**
 * Move a document forward, or do nothing.
 *
 * The guard lives in the WHERE clause rather than a read-then-write,
 * because two workers can hold jobs for the same document at once — a
 * reaped job running beside its replacement, or a retry that outlived the
 * stage it belongs to. A conditional update makes the losing writer a
 * no-op instead of a rollback.
 *
 * Returns true when the row actually moved.
 */
export async function advanceStatus(
  client: PoolClient,
  documentId: string,
  next: DocStatus,
): Promise<boolean> {
  const from = allowedFrom(next);
  if (from.length === 0) return false;

  const { rowCount } = await client.query(
    `update documents
        set status = $2::doc_status,
            status_changed_at = now(),
            updated_at = now(),
            stage_error = case when $2 = 'failed' then stage_error else null end,
            failed_stage = case when $2 = 'failed' then failed_stage else null end
      where id = $1
        and status = any($3::doc_status[])`,
    [documentId, next, from],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Terminal failure. Skipping the forward-only guard on purpose: a document
 * can fail from any live stage, and the reason matters more than the
 * position it failed at.
 */
export async function failDocument(
  client: PoolClient,
  documentId: string,
  stage: JobType | string,
  error: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `update documents
        set status = 'failed',
            failed_stage = $2,
            stage_error = $3,
            status_changed_at = now(),
            updated_at = now()
      where id = $1 and status <> 'done'`,
    [documentId, stage, error.slice(0, 2000)],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Put a finished or failed document back at the start. The only way out of
 * a terminal state, and deliberately explicit — nothing in the pipeline
 * does this on its own.
 */
export async function reprocess(client: PoolClient, documentId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `update documents
        set status = 'queued', stage_error = null, failed_stage = null,
            status_changed_at = now(), updated_at = now()
      where id = $1 and status in ('done', 'failed')`,
    [documentId],
  );
  return (rowCount ?? 0) > 0;
}
