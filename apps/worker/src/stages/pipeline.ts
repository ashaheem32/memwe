import type { JobType } from "@memwe/contracts";
import { STAGES } from "./index.js";

/**
 * The document pipeline, in order. `advance` moves to the next stage that
 * is actually implemented, so building chunking is a matter of registering
 * it — no stage needs to know what follows it.
 */
export const PIPELINE: readonly JobType[] = [
  "document.accept",
  "document.extract",
  "document.chunk",
  "document.embed",
  "document.index",
] as const;

export function nextStage(current: JobType): JobType | null {
  const i = PIPELINE.indexOf(current);
  if (i < 0) return null;
  for (let j = i + 1; j < PIPELINE.length; j++) {
    const candidate = PIPELINE[j];
    if (candidate && STAGES[candidate]) return candidate;
  }
  return null;
}
