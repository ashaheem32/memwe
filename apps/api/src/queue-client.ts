import { pool } from "@memwe/db";
import type { JobType } from "@memwe/contracts";

/**
 * The API's write side of the queue. Deliberately not importing the
 * worker's Queue class — the API should be able to enqueue without
 * pulling in stage code. Same table, same semantics.
 */
export async function enqueue(input: {
  type: JobType;
  payload: Record<string, unknown>;
  traceId: string;
  dedupeKey?: string;
}): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into jobs (type, payload, trace_id, dedupe_key)
     values ($1,$2,$3,$4) on conflict do nothing returning id::text`,
    [input.type, input.payload, input.traceId, input.dedupeKey ?? null],
  );
  return rows[0]?.id ?? null;
}
