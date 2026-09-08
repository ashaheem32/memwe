import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { MemweError } from "@memwe/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { disposeBrowser } from "../apps/worker/src/fetch/browser.js";
import {
  type FetchConfig,
  fetchConfig,
  fetchUrl,
  routeDecision,
  shellReason,
} from "../apps/worker/src/fetch/index.js";
import { logger } from "../apps/worker/src/log.js";

const log = logger({ svc: "test" });
const prose = "<p>Server-rendered paragraph with enough words to count as real content.</p>".repeat(
  10,
);
const seen: string[] = [];
let server: Server;
let base: string;

/** Every page shape the fetcher has to handle, on a loopback port. */
beforeAll(async () => {
  const article = await readFile(join("packages", "db", "fixtures", "article.html"));
  server = createServer((req, res) => {
    seen.push(req.url ?? "");
    const send = (
      status: number,
      type: string,
      body: Buffer | string,
      headers: Record<string, string> = {},
    ) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    switch (req.url) {
      case "/article":
        return send(200, "text/html; charset=utf-8", article);
      case "/redirect":
        return send(302, "text/plain", "", { location: "/article" });
      case "/loop":
        return send(302, "text/plain", "", { location: "/loop" });
      case "/to-file":
        return send(302, "text/plain", "", { location: "file:///etc/passwd" });
      case "/pdf":
        return send(200, "application/pdf", Buffer.from("%PDF-1.4 fake"));
      case "/huge":
        return send(200, "text/html", `<html><body>${"x".repeat(200_000)}</body></html>`);
      case "/missing":
        return send(404, "text/plain", "no");
      case "/broken":
        return send(503, "text/plain", "later");
      case "/shell":
        return send(
          200,
          "text/html",
          `<!DOCTYPE html><html><head><title>App</title></head><body>
             <div id="root"></div>
             <script>
               document.getElementById("root").innerHTML =
                 "<article><h1>Rendered Title</h1>${prose}<img src='/img.png'></article>";
             </script></body></html>`,
        );
      case "/img.png":
        return send(200, "image/png", Buffer.alloc(8));
      default:
        return send(200, "text/html", `<html><body><article>${prose}</article></body></html>`);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await disposeBrowser();
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => {
  vi.unstubAllEnvs();
  seen.length = 0;
});

const cfg = (over: Partial<FetchConfig> = {}): FetchConfig => ({
  ...fetchConfig(),
  allowPrivate: true,
  mode: "http",
  ...over,
});

describe("url fetch, plain http", () => {
  it("fetches HTML with its content type and charset", async () => {
    const r = await fetchUrl(`${base}/article`, cfg(), log);
    expect(r).toMatchObject({
      status: 200,
      contentType: "text/html",
      charset: "utf-8",
      via: "http",
      redirects: 0,
    });
    expect(r.finalUrl).toBe(`${base}/article`);
    expect(r.bytes.toString()).toContain("Why Postgres Row Locks Are Enough");
  });

  it("follows redirects, checking each hop, and reports where it landed", async () => {
    const r = await fetchUrl(`${base}/redirect`, cfg(), log);
    expect(r.finalUrl).toBe(`${base}/article`);
    expect(r.redirects).toBe(1);
    await expect(fetchUrl(`${base}/loop`, cfg({ maxRedirects: 3 }), log)).rejects.toThrow(
      /redirects/,
    );
    await expect(fetchUrl(`${base}/to-file`, cfg(), log)).rejects.toThrow(/scheme file:/);
  });

  it("resolves names through the guard at connect time, in the shape undici expects", async () => {
    // A literal address skips DNS entirely, so this is the only path that
    // exercises the lookup hook: a name the injected resolver maps to the
    // test server.
    const port = (server.address() as AddressInfo).port;
    const lookup = async (host: string) => (host === "local.test" ? ["127.0.0.1"] : []);
    const r = await fetchUrl(`http://local.test:${port}/article`, cfg(), log, { lookup });
    expect(r.status).toBe(200);
    expect(r.finalUrl).toBe(`http://local.test:${port}/article`);
    await expect(
      fetchUrl(`http://other.test:${port}/article`, cfg(), log, { lookup }),
    ).rejects.toThrow(/did not resolve/);
  });

  it("passes non-HTML bytes through untouched for the other extractors", async () => {
    const r = await fetchUrl(`${base}/pdf`, cfg({ mode: "auto" }), log);
    expect(r.contentType).toBe("application/pdf");
    expect(r.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(r.via).toBe("http");
  });

  it("caps the body while it streams", async () => {
    await expect(fetchUrl(`${base}/huge`, cfg({ maxBytes: 50_000 }), log)).rejects.toThrow(
      /exceeds 50000 bytes/,
    );
  });

  it("maps HTTP failures onto the retry taxonomy", async () => {
    const missing = await fetchUrl(`${base}/missing`, cfg(), log).catch((e: MemweError) => e);
    expect(missing).toMatchObject({ code: "not_found", retryable: false });
    const broken = await fetchUrl(`${base}/broken`, cfg(), log).catch((e: MemweError) => e);
    expect(broken).toMatchObject({ code: "upstream_failed", retryable: true });
  });

  it("refuses private hosts unless told otherwise, before any request is made", async () => {
    await expect(fetchUrl(`${base}/article`, cfg({ allowPrivate: false }), log)).rejects.toThrow(
      /not public/,
    );
    expect(seen).toEqual([]);
    await expect(
      fetchUrl("http://169.254.169.254/latest/meta-data/", cfg(), log),
    ).rejects.toThrow();
  });

  it("does not render in http mode even when the page is a shell", async () => {
    const r = await fetchUrl(`${base}/shell`, cfg(), log);
    expect(r.via).toBe("http");
    expect(r.rendered).toBeUndefined();
    // What came back is the shell itself, which the detector recognises as one.
    expect(shellReason(r.bytes.toString())).toMatch(/chars of text/);
  });

  it("reads its configuration from the environment and refuses nonsense", () => {
    vi.stubEnv("URL_FETCH_MODE", "sometimes");
    expect(() => fetchConfig()).toThrow(/URL_FETCH_MODE/);
    vi.stubEnv("URL_FETCH_MODE", "headless");
    vi.stubEnv("URL_MAX_BYTES", "-1");
    expect(() => fetchConfig()).toThrow(/URL_MAX_BYTES/);
  });
});

// A Chromium download is a poor thing to put in every local run, so the
// browser path is opt-in, like OCR:
//   RUN_BROWSER_TESTS=1 pnpm test
// CI installs the browser and sets the flag.
const browserIt = process.env.RUN_BROWSER_TESTS === "1" ? it : it.skip;

describe("url fetch, headless", () => {
  browserIt(
    "renders a page whose content only exists after scripts run",
    { timeout: 60_000 },
    async () => {
      const r = await fetchUrl(`${base}/shell`, cfg({ mode: "auto" }), log);
      expect(r.via).toBe("headless");
      expect(r.rendered).toMatch(/chars of text/);
      expect(r.contentType).toBe("text/html");
      expect(r.bytes.toString()).toContain("Rendered Title");
      expect(r.bytes.toString()).toContain("Server-rendered paragraph");
      // Images are never fetched: the page's <img> did not reach the server.
      expect(seen.filter((u) => u === "/img.png")).toEqual([]);
      // Two document requests: the http probe, then the browser's navigation.
      expect(seen.filter((u) => u === "/shell")).toHaveLength(2);
    },
  );

  browserIt(
    "always renders in headless mode, and leaves a server-rendered page's text intact",
    { timeout: 60_000 },
    async () => {
      const r = await fetchUrl(`${base}/article`, cfg({ mode: "headless" }), log);
      expect(r.via).toBe("headless");
      expect(r.rendered).toBe("URL_FETCH_MODE=headless");
      expect(r.bytes.toString()).toContain("Why Postgres Row Locks Are Enough");
    },
  );

  it("decides every in-page request with the same host policy, without a browser", async () => {
    const lookup = async (host: string) =>
      ({ "cdn.test": ["93.184.216.34"], "evil.test": ["10.0.0.1"] })[host] ?? [];
    const guard = { allowPrivate: false, lookup };
    const checked = new Map<string, Promise<boolean>>();
    expect(await routeDecision("https://cdn.test/app.js", "script", guard, checked)).toBeNull();
    expect(await routeDecision("https://cdn.test/a.png", "image", guard, checked)).toBe(
      "blocked-resource",
    );
    expect(await routeDecision("https://evil.test/x", "xhr", guard, checked)).toBe("blocked-host");
    expect(await routeDecision("http://169.254.169.254/latest/", "fetch", guard, checked)).toBe(
      "blocked-url",
    );
    expect(await routeDecision("file:///etc/passwd", "document", guard, checked)).toBe(
      "blocked-url",
    );
    // Cached per host: the second cdn.test answer needed no lookup.
    expect(checked.size).toBe(2);
  });
});
