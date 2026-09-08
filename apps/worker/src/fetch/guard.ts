import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateAddress, isPrivateName, MemweError, type UrlPolicy } from "@memwe/contracts";

/**
 * A URL a caller hands us is a request to make the worker connect
 * somewhere. Without this file that somewhere can be the cloud metadata
 * service, a database on the private network, or the worker itself. Every
 * hop — the first request, each redirect, every subresource the browser
 * loads — goes through `assertPublicHost` before a socket opens.
 *
 * The network-free half of the policy (scheme, credentials, literal
 * addresses) lives in @memwe/contracts so the API rejects the same URLs.
 */

export type Lookup = (host: string) => Promise<string[]>;

export type GuardOptions = UrlPolicy & { lookup?: Lookup };

const defaultLookup: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** The full check: resolve the name and refuse if any answer is private. */
export async function assertPublicHost(host: string, opts: GuardOptions = {}): Promise<string[]> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare)) {
    if (!opts.allowPrivate && isPrivateAddress(bare))
      throw new MemweError("invalid_request", `host ${host} is not public`);
    return [bare];
  }
  if (!opts.allowPrivate && isPrivateName(bare))
    throw new MemweError("invalid_request", `host ${host} is not public`);
  let addresses: string[];
  try {
    addresses = await (opts.lookup ?? defaultLookup)(bare);
  } catch {
    throw new MemweError("upstream_failed", `host ${host} did not resolve`);
  }
  if (addresses.length === 0)
    throw new MemweError("upstream_failed", `host ${host} did not resolve`);
  // One private answer among public ones is the classic rebinding shape.
  if (!opts.allowPrivate && addresses.some(isPrivateAddress))
    throw new MemweError("invalid_request", `host ${host} resolves to a private address`);
  return addresses;
}
