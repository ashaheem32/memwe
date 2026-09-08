import type { Job, JobType } from "@memwe/contracts";
import type { Logger } from "../log.js";
import { accept } from "./accept.js";
import { chunkStage } from "./chunk.js";
import { contextualizeStage } from "./contextualize.js";
import { embedStage } from "./embed.js";
import { extractStage } from "./extract.js";

export type StageContext = { log: Logger };

/**
 * `halt` stops the pipeline without failing the document — used when a
 * stage discovers there is nothing left to do, such as bytes we already
 * have under another id.
 */
export type StageResult = undefined | { halt: true; reason: string } | { deferMs: number };
export type Stage = (job: Job, ctx: StageContext) => Promise<StageResult>;

/**
 * The stage registry. Adding a pipeline stage means adding a file and a
 * line here — never touching the runner. Unregistered types dead-letter
 * immediately rather than retrying five times into the void.
 */
export const STAGES: Partial<Record<JobType, Stage>> = {
  "document.accept": accept,
  "document.extract": extractStage,
  "document.chunk": chunkStage,
  "document.contextualize": contextualizeStage,
  "document.embed": embedStage,
  // Next: document.index
  // Sprint 3: memory.distill, memory.reconcile
  // Sprint 4: session.promote, graph.consolidate
  // Sprint 6: connector.sync
};
