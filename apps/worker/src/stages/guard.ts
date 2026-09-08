import { DocumentJobPayload, type Job } from "@memwe/contracts";
import { lockIngestion, type PoolClient, tx } from "@memwe/db";

export class StaleJobError extends Error {}

/** Lock order: container, lease, document. No external calls inside this transaction. */
export async function documentTx<T>(job: Job, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const p = DocumentJobPayload.parse(job.payload);
  return tx(async (c) => {
    await lockIngestion(c, p.orgId, p.container);
    if (job.lockedBy) {
      const lease = await c.query(
        `select id from jobs where id=$1 and locked_by=$2
        and attempts=$3 and status='running' for update`,
        [job.id, job.lockedBy, job.attempts],
      );
      if (!lease.rowCount) throw new StaleJobError("job lease has changed");
    }
    const doc = await c.query(
      `select id from documents where id=$1 and org_id=$2
      and container=$3 and revision=$4 and status not in ('done','failed') for update`,
      [p.documentId, p.orgId, p.container, p.revision],
    );
    if (!doc.rowCount) throw new StaleJobError("document revision is no longer active");
    return fn(c);
  });
}
