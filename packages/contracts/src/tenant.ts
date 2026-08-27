import { z } from "zod";

/**
 * Container tag — the isolation namespace. Same rule everywhere:
 * app validation, the Postgres domain, and the SDK.
 *
 * Derive tags from IDs you already have (`org:acme:user:1934`) so any
 * service can reconstruct the right tag without a database lookup.
 */
export const CONTAINER_TAG_RE = /^[a-zA-Z0-9_:-]{1,100}$/;

export const ContainerTag = z
  .string()
  .regex(CONTAINER_TAG_RE, "container must match ^[a-zA-Z0-9_:-]{1,100}$");

export const Tenant = z.object({
  orgId: z.guid(),
  container: ContainerTag,
});
export type Tenant = z.infer<typeof Tenant>;
