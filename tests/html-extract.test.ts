import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractHtml } from "../apps/worker/src/extract/html.js";
import { extract, resolveSpan } from "../apps/worker/src/extract/index.js";
import { sniff } from "../apps/worker/src/extract/sniff.js";
import { shellReason } from "../apps/worker/src/fetch/index.js";
import { logger } from "../apps/worker/src/log.js";

const log = logger({ svc: "test" });
const fixture = (name: string) => readFile(join("packages", "db", "fixtures", name));
const html = (body: string, head = "") =>
  Buffer.from(
    `<!DOCTYPE html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`,
  );

describe("html extraction", () => {
  it("keeps the article and drops the chrome around it", async () => {
    const r = extractHtml(
      {
        bytes: await fixture("article.html"),
        url: "https://example.test/blog/row-locks",
        charset: null,
      },
      log,
    );
    expect(r.title).toBe("Why Postgres Row Locks Are Enough");
    expect(r.stats.readable).toBe(true);
    expect(r.stats.byline).toBe("Ada Example");
    expect(r.publishedAt).toBe("2026-03-04T09:30:00.000Z");
    // Boilerplate: navigation, cookie banner, related posts, footer, scripts.
    for (const gone of [
      "Pricing",
      "Log in",
      "cookies",
      "Related posts",
      "Privacy",
      "newsletter",
      "dataLayer",
      "hero",
    ])
      expect(r.markdown).not.toContain(gone);
    // Content survives, with structure.
    expect(r.markdown).toMatch(/^# Why Postgres Row Locks Are Enough\n\n/);
    expect(r.markdown).toContain("\n## What a lease protects\n");
    expect(r.markdown).toContain(
      "\n- No clock skew between workers\n  - Each worker trusts the database clock\n",
    );
    expect(r.markdown).toContain(
      "\n1. When a single database cannot hold the queue's write rate\n2. ",
    );
    expect(r.markdown).toContain(
      "| Workers | Claims / s | p99 latency |\n| --- | --- | --- |\n| 1 | 1,900 | 3 ms |",
    );
    expect(r.markdown).toContain(
      "```sql\nupdate jobs set status = 'running', locked_by = $1\n where id = (\n",
    );
    expect(r.markdown).toContain('> "Skip locked" is the whole trick.');
    expect(r.markdown).toContain("Figure 1. Claims per second by worker count.");
    // Inline markup is text, not markdown decoration.
    expect(r.markdown).toContain(
      "a single SELECT ... FOR UPDATE SKIP LOCKED does the job, and that the operational simplicity",
    );
    expect(r.markdown).not.toMatch(/\*\*|\]\(/);
    // <br> breaks a line; source newlines do not.
    expect(r.markdown).toContain(
      "The argument has three parts:\nwhat a lease actually protects,\nwhere the throughput goes, and when to move on.",
    );
    expect(r.sections.map((s) => [s.level, s.heading])).toEqual([
      [1, "Why Postgres Row Locks Are Enough"],
      [2, "What a lease protects"],
      [2, "Where the throughput goes"],
      [2, "When to move on"],
    ]);
    expect(r.stats.keptChars).toBeLessThan(r.stats.bodyChars);
  });

  it("maps a paragraph back to its page-text line exactly, and code verbatim", async () => {
    const r = extractHtml({ bytes: await fixture("article.html"), url: null, charset: null }, log);
    const entries = r.spanMap.toJSON();
    const segmentAt = (md: number) => entries.find((e) => e.md <= md && md < (e.mdEnd ?? e.md))!;
    const md = r.markdown.indexOf("A lease is a promise");
    const [loc] = resolveSpan(entries, md, md + 20);
    expect(loc).toMatchObject({ exact: true });
    // An exact segment is the same characters in both coordinate systems, so
    // the offset inside the line is the same on both sides.
    const seg = segmentAt(md);
    expect(seg.exact).toBe(true);
    expect((seg.srcEnd ?? 0) - seg.src).toBe((seg.mdEnd ?? 0) - seg.md);
    expect(loc!.srcStart - seg.src).toBe(md - seg.md);
    expect(r.markdown.slice(seg.md, seg.mdEnd)).toMatch(/^A lease is a promise/);
    const code = r.markdown.indexOf("    for update skip locked");
    const [codeLoc] = resolveSpan(entries, code, code + 26);
    expect(codeLoc?.exact).toBe(true);
    // Headings, list items and fences carry a prefix or nothing: never exact.
    const heading = r.markdown.indexOf("## What a lease protects");
    expect(resolveSpan(entries, heading, heading + 5)[0]?.exact).toBe(false);
    const fence = r.markdown.indexOf("```sql");
    const [fenceLoc] = resolveSpan(entries, fence, fence + 6);
    expect(fenceLoc?.exact).toBe(false);
    expect(fenceLoc!.srcEnd).toBe(fenceLoc!.srcStart); // nothing on the page behind a fence
  });

  it("brings back a reference page's name and synopsis blocks that Readability skips", async () => {
    const r = extractHtml(
      {
        bytes: await fixture("reference.html"),
        url: "https://example.test/ref/frobnicate",
        charset: null,
      },
      log,
    );
    expect(r.stats.readable).toBe(true);
    expect(r.stats.adopted).toBe(2);
    expect(r.markdown).toMatch(
      /^# frobnicate — Example Reference\n\n## frobnicate\n\nfrobnicate, frob — adjust the frobnication level of a widget\n\n## Synopsis\n\n```\nfrobnicate \[ --level n \] \[ --dry-run \] widget \[, \.\.\.\]\n```\n\n## Description\n/,
    );
    expect(r.markdown).not.toMatch(/Submit a correction|Prev:|Home Reference/);
    expect(r.sections.map((s) => s.heading)).toEqual([
      "frobnicate — Example Reference",
      "frobnicate",
      "Synopsis",
      "Description",
      "Options",
    ]);
  });

  it("falls back to stripping chrome by name when nothing reads as an article", () => {
    const r = extractHtml(
      {
        bytes: html(
          `<nav><a href="/">Home</a> <a href="/x">Menu</a></nav>
           <div id="app"><p>Short page.</p><p>Two lines only.</p></div>
           <footer>Footer text</footer>`,
          "<title>Tiny</title>",
        ),
        url: "https://example.test/tiny",
        charset: null,
      },
      log,
    );
    expect(r.stats.readable).toBe(false);
    expect(r.markdown).toBe("# Tiny\n\nShort page.\n\nTwo lines only.");
  });

  it("refuses a page with no text at all", () => {
    expect(() =>
      extractHtml(
        { bytes: html('<div id="root"></div><script>render()</script>'), url: null, charset: null },
        log,
      ),
    ).toThrow(/no readable text/);
  });

  it("honours a declared charset over the byte guess", () => {
    const latin1 = Buffer.from("<html><body><p>caf\xe9 ol\xe9</p></body></html>", "latin1");
    expect(
      extractHtml({ bytes: latin1, url: null, charset: "iso-8859-1" }, log).markdown,
    ).toContain("café olé");
  });

  it("is routed by the sniffer from declared type or leading bytes, and reaches the pipeline", async () => {
    expect(
      (await sniff(Buffer.from("<!DOCTYPE html><html><body>x</body></html>"), null, null)).kind,
    ).toBe("html");
    expect(
      (await sniff(Buffer.from("  \n<html lang=en><body>x</body></html>"), null, null)).kind,
    ).toBe("html");
    expect((await sniff(Buffer.from("plain text with <b>a tag</b> inside"), null, null)).kind).toBe(
      "text",
    );
    expect((await sniff(Buffer.from("plain text"), "text/html", null)).kind).toBe("html");
    const r = await extract(
      {
        bytes: await fixture("article.html"),
        declaredMime: "text/html",
        filename: "row-locks.html",
        sourceUri: "https://example.test/blog/row-locks",
      },
      log,
    );
    expect(r.doc.mime).toBe("text/html");
    expect(r.doc.title).toBe("Why Postgres Row Locks Are Enough");
    expect(r.doc.occurredAt).toBe("2026-03-04T09:30:00.000Z");
    expect(r.doc.sections).toHaveLength(4);
    expect(r.stats).toMatchObject({ format: "html", readable: true, sections: 4 });
  });
});

describe("javascript shell detection", () => {
  it("flags pages whose text only arrives with scripts", () => {
    expect(
      shellReason('<html><body><div id="root"></div><script src="/app.js"></script></body></html>'),
    ).toMatch(/chars of text/);
    expect(
      shellReason(
        '<html><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="app"></div></body></html>',
      ),
    ).toMatch(/needs JavaScript/);
    const prose = `<html><body><article>${"<p>Real server-rendered paragraph with enough words to count.</p>".repeat(12)}</article></body></html>`;
    expect(shellReason(prose)).toBeNull();
  });
});
