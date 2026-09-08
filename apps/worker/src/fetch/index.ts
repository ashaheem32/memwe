import { assertFetchableUrl, MemweError } from "@memwe/contracts";
import { Agent, type Response, fetch as undiciFetch } from "undici";
import type { Logger } from "../log.js";
import { getBrowser } from "./browser.js";
import { assertPublicHost, type Lookup } from "./guard.js";

/**
 * Fetching a URL, two ways.
 *
 * Plain HTTP is a few hundred milliseconds and gets every server-rendered
 * page. A headless browser is a few seconds and gets the rest — pages that
 * are an empty shell until their scripts run. `auto` tries the cheap one
 * and escalates when the HTML looks like a shell; `headless` always
 * renders; `http` never does. Either way the first request is plain HTTP,
 * because a URL can point at a PDF, and a browser is the wrong tool for
 * bytes it would only try to display.
 */

export type FetchMode = "auto" | "http" | "headless";

export type FetchConfig = {
  mode: FetchMode;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  allowPrivate: boolean;
  userAgent: string;
};

export type Fetched = {
  bytes: Buffer;
  /** Media type without parameters, lower-case; null when the server sent none. */
  contentType: string | null;
  /** The charset parameter of the content type, when the server sent one. */
  charset: string | null;
  /** The URL that answered, after redirects. */
  finalUrl: string;
  status: number;
  via: "http" | "headless";
  redirects: number;
  elapsedMs: number;
  /** Why the browser ran, when it did. */
  rendered?: string;
};

/** Read per call, like every other stage's configuration. */
export function fetchConfig(): FetchConfig {
  const mode = process.env["URL_FETCH_MODE"] ?? "auto";
  if (!["auto", "http", "headless"].includes(mode))
    throw new MemweError("invalid_request", `unknown URL_FETCH_MODE ${mode}`);
  const int = (name: string, fallback: number) => {
    const n = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(n) || n <= 0)
      throw new MemweError("invalid_request", `${name} must be a positive integer`);
    return n;
  };
  return {
    mode: mode as FetchMode,
    timeoutMs: int("URL_FETCH_TIMEOUT_MS", 20_000),
    maxBytes: int("URL_MAX_BYTES", 20 * 1024 * 1024),
    maxRedirects: int("URL_MAX_REDIRECTS", 5),
    allowPrivate: process.env["URL_ALLOW_PRIVATE"] === "true",
    userAgent:
      process.env["URL_USER_AGENT"] ??
      "Mozilla/5.0 (compatible; memwe/0.1; +https://github.com/ashaheem32/memwe)",
  };
}

export type FetchOptions = { lookup?: Lookup };

export async function fetchUrl(
  raw: string,
  cfg: FetchConfig,
  log: Logger,
  opts: FetchOptions = {},
): Promise<Fetched> {
  const started = Date.now();
  const guard = { allowPrivate: cfg.allowPrivate, ...(opts.lookup ? { lookup: opts.lookup } : {}) };
  const url = assertFetchableUrl(raw, guard);
  const first = await httpFetch(url, cfg, guard);
  const elapsed = () => Date.now() - started;
  if (!isHtml(first.contentType) || cfg.mode === "http") {
    return { ...first, via: "http", elapsedMs: elapsed() };
  }
  const reason =
    cfg.mode === "headless" ? "URL_FETCH_MODE=headless" : shellReason(first.bytes.toString("utf8"));
  if (!reason) return { ...first, via: "http", elapsedMs: elapsed() };
  log.info("rendering in headless browser", { url: first.finalUrl, why: reason });
  const rendered = await render(new URL(first.finalUrl), cfg, guard, log);
  return {
    ...rendered,
    redirects: first.redirects + rendered.redirects,
    via: "headless",
    rendered: reason,
    elapsedMs: elapsed(),
  };
}

export function isHtml(contentType: string | null): boolean {
  return contentType === "text/html" || contentType === "application/xhtml+xml";
}

function mediaType(header: string | null): string | null {
  const type = header?.split(";")[0]?.trim().toLowerCase();
  return type || null;
}

function charsetOf(header: string | null): string | null {
  const m = /;\s*charset\s*=\s*"?([\w.:-]+)"?/i.exec(header ?? "");
  return m?.[1]?.toLowerCase() ?? null;
}

/**
 * Does this HTML carry its content, or only the scripts that will? Cheap
 * and structural on purpose — it runs on every fetched page. A wrong "yes"
 * costs one browser render; a wrong "no" costs the document its text, so
 * the thresholds lean towards rendering.
 */
export function shellReason(html: string): string | null {
  const head = html.slice(0, 2_000_000);
  if (/<noscript[^>]*>[^<]*(?:enable|requires?|turn on)\s+javascript/i.test(head))
    return "page says it needs JavaScript";
  const stripped = head
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(stripped);
  const body = bodyMatch?.[1] ?? stripped;
  const text = body
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 400) return `only ${text.length} chars of text without JavaScript`;
  return null;
}

/**
 * Plain HTTP with three guards a default fetch lacks: the address is
 * checked again at connect time (so a name that changed its answer between
 * lookup and connect cannot reach a private address), every redirect hop
 * is checked before it is followed, and the body is capped while it streams.
 */
async function httpFetch(
  start: URL,
  cfg: FetchConfig,
  guard: Guard,
): Promise<Omit<Fetched, "via" | "elapsedMs">> {
  const dispatcher = new Agent({
    connect: {
      // Node's dns.lookup contract: with `all` the callback wants every
      // address, otherwise one. undici asks for all and picks its own order.
      lookup: (hostname, options, callback) => {
        const family = (a: string) => (a.includes(":") ? 6 : 4);
        assertPublicHost(hostname, guard).then(
          (addresses) => {
            if (options?.all) {
              (
                callback as unknown as (
                  err: null,
                  addrs: { address: string; family: number }[],
                ) => void
              )(
                null,
                addresses.map((address) => ({ address, family: family(address) })),
              );
            } else {
              const address = addresses[0] ?? "";
              callback(null, address, family(address));
            }
          },
          (err: Error) => callback(err, "", 4),
        );
      },
    },
    connectTimeout: cfg.timeoutMs,
    headersTimeout: cfg.timeoutMs,
    bodyTimeout: cfg.timeoutMs,
  });
  try {
    let url = start;
    for (let hop = 0; ; hop++) {
      await assertPublicHost(url.hostname, guard);
      let res: Awaited<ReturnType<typeof undiciFetch>>;
      try {
        res = await undiciFetch(url, {
          dispatcher,
          redirect: "manual",
          signal: AbortSignal.timeout(cfg.timeoutMs),
          headers: {
            "user-agent": cfg.userAgent,
            accept: "text/html,application/xhtml+xml,application/pdf,text/*;q=0.9,*/*;q=0.5",
            "accept-language": "en,*;q=0.5",
          },
        });
      } catch (err) {
        if (err instanceof MemweError) throw err;
        // undici wraps the real failure as `cause`; the outer message is always "fetch failed".
        const cause = err instanceof Error ? (err.cause ?? err) : err;
        if (cause instanceof MemweError) throw cause;
        const reason = cause instanceof Error ? cause.message : String(cause);
        const code = cause instanceof Error && "code" in cause ? ` (${String(cause.code)})` : "";
        throw new MemweError("upstream_failed", `fetch failed: ${reason}${code}`);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location)
          throw new MemweError("upstream_failed", `redirect ${res.status} without location`);
        if (hop >= cfg.maxRedirects)
          throw new MemweError("upstream_failed", `more than ${cfg.maxRedirects} redirects`);
        url = assertFetchableUrl(new URL(location, url).href, guard);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel();
        throw new MemweError(statusCode(res.status), `url answered ${res.status}`, {
          status: res.status,
        });
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > cfg.maxBytes)
        throw new MemweError(
          "unsupported_content",
          `response is ${declared} bytes; limit ${cfg.maxBytes}`,
        );
      const bytes = await readCapped(res.body, cfg.maxBytes);
      return {
        bytes,
        contentType: mediaType(res.headers.get("content-type")),
        charset: charsetOf(res.headers.get("content-type")),
        finalUrl: url.href,
        status: res.status,
        redirects: hop,
      };
    }
  } finally {
    await dispatcher.close();
  }
}

function statusCode(
  status: number,
): "not_found" | "invalid_request" | "rate_limited" | "upstream_failed" {
  if (status === 404 || status === 410) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "invalid_request";
  return "upstream_failed";
}

async function readCapped(body: Response["body"], maxBytes: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new MemweError("unsupported_content", `response exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** Resource types a page needs to run, versus ones it only needs to look right. */
const BLOCKED_RESOURCES = new Set(["image", "media", "font", "websocket", "manifest", "other"]);

export type Guard = { allowPrivate: boolean; lookup?: Lookup };

/**
 * What the browser may load. Every request a page makes — scripts, XHR,
 * iframes, redirects it follows on its own — is decided here, with the
 * same host policy as the first request. `checked` caches per page so a
 * hundred requests to one CDN cost one lookup.
 */
export async function routeDecision(
  url: string,
  resourceType: string,
  guard: Guard,
  checked: Map<string, Promise<boolean>>,
): Promise<"blocked-resource" | "blocked-url" | "blocked-host" | null> {
  if (BLOCKED_RESOURCES.has(resourceType)) return "blocked-resource";
  let target: URL;
  try {
    target = assertFetchableUrl(url, guard);
  } catch {
    return "blocked-url";
  }
  let ok = checked.get(target.hostname);
  if (!ok) {
    ok = assertPublicHost(target.hostname, guard).then(
      () => true,
      () => false,
    );
    checked.set(target.hostname, ok);
  }
  return (await ok) ? null : "blocked-host";
}

async function render(
  url: URL,
  cfg: FetchConfig,
  guard: Guard,
  log: Logger,
): Promise<Omit<Fetched, "via" | "elapsedMs">> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: cfg.userAgent,
    javaScriptEnabled: true,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  const deadline = Date.now() + cfg.timeoutMs;
  try {
    const page = await context.newPage();
    const checked = new Map<string, Promise<boolean>>();
    await page.route("**/*", async (route) => {
      const request = route.request();
      const verdict = await routeDecision(request.url(), request.resourceType(), guard, checked);
      if (verdict === "blocked-host" || verdict === "blocked-url")
        log.warn("browser request blocked", { url: request.url(), why: verdict });
      return verdict ? route.abort("blockedbyclient") : route.continue();
    });
    let redirects = 0;
    page.on("response", (r) => {
      if (r.request().isNavigationRequest() && r.status() >= 300 && r.status() < 400) redirects++;
    });
    let response: Awaited<ReturnType<typeof page.goto>>;
    try {
      response = await page.goto(url.href, {
        waitUntil: "domcontentloaded",
        timeout: cfg.timeoutMs,
      });
    } catch (err) {
      throw new MemweError(
        "upstream_failed",
        `browser navigation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response)
      throw new MemweError("upstream_failed", "browser navigation produced no response");
    if (response.status() < 200 || response.status() >= 300)
      throw new MemweError(statusCode(response.status()), `url answered ${response.status()}`, {
        status: response.status(),
      });
    // Give scripts a moment to fetch and render, but never wait on a page
    // that polls forever: the remaining budget, capped, is the most it gets.
    const settle = Math.max(0, Math.min(5_000, deadline - Date.now()));
    await page.waitForLoadState("networkidle", { timeout: settle }).catch(() => undefined);
    const html = await page.content();
    const bytes = Buffer.from(html, "utf8");
    if (bytes.byteLength > cfg.maxBytes)
      throw new MemweError("unsupported_content", `rendered page exceeds ${cfg.maxBytes} bytes`);
    return {
      bytes,
      contentType: mediaType(response.headers()["content-type"] ?? null) ?? "text/html",
      // page.content() serialises as UTF-8 whatever the server sent.
      charset: "utf-8",
      finalUrl: page.url(),
      status: response.status(),
      redirects,
    };
  } finally {
    await context.close();
  }
}
