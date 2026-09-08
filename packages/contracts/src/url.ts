import { isIP } from "node:net";
import { MemweError } from "./errors.js";

/**
 * Which URLs the platform will fetch on a caller's behalf. The API applies
 * this synchronously so a bad URL is a 400, not a failed document; the
 * worker applies it again, plus a DNS check, before any socket opens.
 * Everything that needs no network lives here so both sides agree.
 */

export type UrlPolicy = {
  /** Development and tests only: lets 127.0.0.1 and friends through. */
  allowPrivate?: boolean;
};

/** Scheme, credentials and the literal host — everything that needs no DNS. */
export function assertFetchableUrl(raw: string, opts: UrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MemweError("invalid_request", "url is not valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new MemweError("invalid_request", `url scheme ${url.protocol} is not fetched`);
  if (url.username || url.password)
    throw new MemweError("invalid_request", "url must not carry credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!opts.allowPrivate && isPrivateName(host))
    throw new MemweError("invalid_request", `url host ${url.hostname} is not public`);
  const ip = isIP(host);
  if (ip && !opts.allowPrivate && isPrivateAddress(host))
    throw new MemweError("invalid_request", `url host ${url.hostname} is not public`);
  return url;
}

export function isPrivateName(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".home.arpa") ||
    h === "metadata.google.internal"
  );
}

export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPrivateV4(address);
  if (kind === 6) return isPrivateV6(address);
  // Not an address at all — treat as unsafe; the caller should have resolved it.
  return true;
}

function isPrivateV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || // this network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 192 && b === 0) || // IETF protocol assignments, 192.0.0.0/24
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

function isPrivateV6(address: string): boolean {
  const a = address.toLowerCase();
  // IPv4-mapped and IPv4-compatible forms carry a v4 address that must be checked as one.
  const mapped = /^(?:0*:)*(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped?.[1]) return isPrivateV4(mapped[1]);
  const expanded = expandV6(a);
  if (!expanded) return true;
  const first = Number.parseInt(expanded.slice(0, 4), 16);
  if (expanded === "0".repeat(32)) return true; // unspecified
  if (expanded === `${"0".repeat(31)}1`) return true; // loopback
  // ::ffff:a.b.c.d after the URL parser has rewritten it as hex groups.
  if (expanded.startsWith(`${"0".repeat(20)}ffff`) || expanded.startsWith("0".repeat(24))) {
    const v4 = expanded.slice(24);
    const octets = [0, 2, 4, 6].map((i) => Number.parseInt(v4.slice(i, i + 2), 16));
    return isPrivateV4(octets.join("."));
  }
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (expanded.startsWith("20010db8")) return true; // documentation
  if (expanded.startsWith("0064ff9b")) {
    // NAT64 well-known prefix 64:ff9b::/96 wraps a v4 address in the last 32 bits.
    const v4 = expanded.slice(24);
    const octets = [0, 2, 4, 6].map((i) => Number.parseInt(v4.slice(i, i + 2), 16));
    return isPrivateV4(octets.join("."));
  }
  return false;
}

/** Eight zero-padded 16-bit groups as one hex string, or null if malformed. */
function expandV6(address: string): string | null {
  const zoneless = address.split("%")[0] ?? "";
  const halves = zoneless.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, "0")).join("");
}
