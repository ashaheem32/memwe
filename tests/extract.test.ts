import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decode } from "../apps/worker/src/extract/decode.js";
import { extract } from "../apps/worker/src/extract/index.js";
import { sectionTree } from "../apps/worker/src/extract/markdown.js";
import { disposeOcr } from "../apps/worker/src/extract/ocr.js";
import { extractPdf } from "../apps/worker/src/extract/pdf.js";
import { sniff } from "../apps/worker/src/extract/sniff.js";
import { resolveSpan } from "../apps/worker/src/extract/spans.js";
import { logger } from "../apps/worker/src/log.js";

const FIXTURES = join(import.meta.dirname, "..", "packages", "db", "fixtures");
const fixture = (name: string) => readFile(join(FIXTURES, name));
const quiet = logger({ svc: "test" });
const run = (bytes: Buffer, mime: string | null = null, filename: string | null = null) =>
  extract({ bytes, declaredMime: mime, filename }, quiet);

afterAll(async () => {
  await disposeOcr();
});

describe("sniffing", () => {
  it("trusts the bytes, not the extension", async () => {
    // PNG bytes behind a .txt name — the whole reason this fixture exists.
    const d = await sniff(await fixture("actually-a-png.txt"), "text/plain", "actually-a-png.txt");
    expect(d.kind).toBe("unsupported");
    expect(d.mime).toBe("image/png");
    expect(d.declaredMismatch).toBe("text/plain");
  });

  it("detects a PDF regardless of what it was called", async () => {
    const d = await sniff(await fixture("simple.pdf"), "text/plain", "notes.txt");
    expect(d.kind).toBe("pdf");
    expect(d.declaredMismatch).toBe("text/plain");
  });

  it("separates markdown from prose", async () => {
    expect((await sniff(Buffer.from("# Title\n\ntext"), null, null)).kind).toBe("markdown");
    expect((await sniff(Buffer.from("just a sentence."), null, null)).kind).toBe("text");
  });
});

describe("decoding", () => {
  it("strips a UTF-8 BOM", () => {
    const d = decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi")]));
    expect(d.text).toBe("hi");
    expect(d.bomStripped).toBe(true);
  });

  it("handles UTF-16", () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")]);
    expect(decode(le).text).toBe("hi");
    expect(decode(le).encoding).toBe("utf-16le");
  });

  it("falls back to latin1 when the bytes are not UTF-8", () => {
    expect(decode(Buffer.from([0xe9, 0xe8, 0xea, 0xfc, 0xff])).encoding).toBe("latin1");
  });
});

describe("plain text", () => {
  it("extracts and reports its encoding", async () => {
    const r = await run(Buffer.from("Shaheem prefers terse answers.\n"), "text/plain");
    expect(r.doc.markdown).toContain("terse answers");
    expect(r.stats.format).toBe("text");
    expect(r.stats.encoding).toBe("utf-8");
  });

  it("normalises CRLF and records the offset shift", async () => {
    const r = await run(Buffer.from("one\r\ntwo\r\nthree"), "text/plain");
    expect(r.doc.markdown).toBe("one\ntwo\nthree");
    // Each CRLF collapsed moves every later source offset by one. If the
    // span map ignored that, provenance on Windows files points at the
    // wrong characters.
    const last = r.doc.spanMap.at(-1);
    expect(last).toBeDefined();
    expect(last!.src).toBeGreaterThan(last!.md);
  });

  it("survives RTL, emoji and combining marks", async () => {
    const r = await run(await fixture("unicode.txt"), "text/plain");
    expect(r.doc.markdown).toContain("مرحبا");
    expect(r.doc.markdown).toContain("👨‍👩‍👧‍👦");
    expect(r.stats.encoding).toBe("utf-8");
  });

  it("fails an empty document rather than the batch", async () => {
    await expect(run(await fixture("empty.txt"), "text/plain")).rejects.toThrow(
      /empty|cannot extract/i,
    );
  });

  it("does not retry unsupported content", async () => {
    await expect(run(await fixture("actually-a-png.txt"), "text/plain")).rejects.toMatchObject({
      code: "unsupported_content",
      retryable: false,
    });
  });
});

describe("markdown", () => {
  it("builds the section tree and takes the title from the first H1", async () => {
    const r = await run(await fixture("structured.md"), "text/markdown", "structured.md");
    expect(r.stats.format).toBe("markdown");
    expect(r.doc.title).toBe("Latency budget");
    const headings = r.doc.sections.map((s) => s.heading);
    expect(headings).toContain("Retrieval");
    expect(headings).toContain("Dense");
    expect(headings).toContain("Reranking");
  });

  it("ignores headings inside fenced code", () => {
    // `# not a heading` in a bash block is a comment. Treating it as
    // structure splits the fence in half.
    const md = "# Real\n\n```bash\n# not a heading\necho hi\n```\n\n## Also real\n";
    expect(sectionTree(md).map((s) => s.heading)).toEqual(["Real", "Also real"]);
  });

  it("closes a section when a same-or-higher level heading arrives", () => {
    const s = sectionTree("# A\ntext\n## B\nmore\n# C\nend\n");
    const a = s.find((x) => x.heading === "A");
    const c = s.find((x) => x.heading === "C");
    expect(a).toBeDefined();
    expect(c).toBeDefined();
    expect(a!.end).toBeLessThanOrEqual(c!.start);
  });
});

describe("pdf", () => {
  it("extracts the text layer across pages", async () => {
    const r = await run(await fixture("simple.pdf"), "application/pdf", "simple.pdf");
    expect(r.stats.format).toBe("pdf");
    expect(r.stats.pages).toBe(2);
    expect(r.stats.ocrPages).toBe(0);
    expect(r.doc.markdown).toContain("Latency budget");
    expect(r.doc.markdown).toContain("Page two");
  });

  it("carries a page number in the span map", async () => {
    const r = await run(await fixture("simple.pdf"), "application/pdf");
    const pages = r.doc.spanMap.map((e) => e.page);
    expect(pages).toContain(1);
    expect(pages).toContain(2);
  });

  it("recovers from a corrupted xref", async () => {
    // Real-world PDFs are broken constantly; the extractor must repair
    // rather than reject.
    const r = await run(await fixture("broken-xref.pdf"), "application/pdf");
    expect(r.doc.markdown).toContain("Latency budget");
  });

  it("refuses to guess when OCR is disabled and there is no text layer", async () => {
    const prev = process.env.OCR_ENABLED;
    process.env.OCR_ENABLED = "false";
    try {
      // Config is read per call, so the env var alone is enough.
      await expect(extractPdf(await fixture("scanned.pdf"), quiet)).rejects.toThrow(
        /no text layer|OCR is disabled/i,
      );
    } finally {
      if (prev === undefined) delete process.env.OCR_ENABLED;
      else process.env.OCR_ENABLED = prev;
    }
  });
});

describe("pdf structure and normalization", () => {
  it("removes running headers and page numbers", async () => {
    // A running head repeated on every page would otherwise land in every
    // chunk, diluting each embedding with the document's title.
    const r = await run(await fixture("report.pdf"), "application/pdf", "report.pdf");
    expect(r.doc.markdown).not.toMatch(/Quarterly Report/);
    expect(r.doc.markdown).not.toMatch(/^Page \d+$/m);
    expect(r.stats.runningHeadsRemoved).toBeGreaterThan(0);
  });

  it("infers a heading hierarchy from font size", async () => {
    // PDFs have no headings, only text that is bigger. Chunking needs the
    // structure, so it is recovered rather than given up on.
    const r = await run(await fixture("report.pdf"), "application/pdf");
    const h1 = r.doc.sections.filter((s) => s.level === 1).map((s) => s.heading);
    const h2 = r.doc.sections.filter((s) => s.level === 2).map((s) => s.heading);
    expect(h1).toEqual(["Retrieval Architecture"]);
    expect(h2).toEqual(["Overview", "Reranking", "Consolidation", "Conclusion"]);
    expect(r.doc.markdown).toMatch(/^# Retrieval Architecture$/m);
  });

  it("joins words the layout broke across lines", async () => {
    const r = await run(await fixture("report.pdf"), "application/pdf");
    expect(r.doc.markdown).toContain("recurring");
    expect(r.doc.markdown).not.toContain("recur-");
  });

  it("emits a span segment per line, not per page", async () => {
    const r = await run(await fixture("report.pdf"), "application/pdf");
    expect(r.doc.spanMap.length).toBeGreaterThan(r.stats.pages as number);
    expect(r.doc.spanMap.every((e) => e.page !== undefined)).toBe(true);
    expect(r.doc.spanMap.some((e) => e.bbox !== undefined)).toBe(true);
  });

  it("resolves a phrase back to the page it was printed on", async () => {
    // This is what /why consumes. A span map that cannot do this is
    // decoration, not provenance.
    const r = await run(await fixture("report.pdf"), "application/pdf");
    const at = r.doc.markdown.indexOf("Consolidation");
    const [loc] = resolveSpan(r.doc.spanMap, at, at + "Consolidation".length, {
      markdownLength: r.doc.markdown.length,
    });
    expect(loc).toBeDefined();
    expect(loc!.page).toBe(3);
    expect(loc!.bbox).toBeDefined();
  });

  it("cites every page a range crosses", async () => {
    const r = await run(await fixture("report.pdf"), "application/pdf");
    const at = r.doc.markdown.indexOf("Reranking");
    const locs = resolveSpan(r.doc.spanMap, at - 40, at + 40, {
      markdownLength: r.doc.markdown.length,
    });
    expect([...new Set(locs.map((l) => l.page))]).toEqual([1, 2]);
  });
});

describe("NormalizedDoc completeness", () => {
  it("carries the ACL, trust tier and source URI through extraction", async () => {
    // Dropping these silently breaks two rules: ACL intersection on
    // distilled memories, and never treating untrusted text as instruction.
    const acl = { owners: ["user:1"], readers: ["group:eng"], public: false };
    const r = await extract(
      {
        bytes: await fixture("structured.md"),
        declaredMime: "text/markdown",
        filename: "structured.md",
        sourceUri: "https://example.com/doc",
        acl,
        trust: "external",
      },
      quiet,
    );
    expect(r.doc.acl).toMatchObject(acl);
    expect(r.doc.trust).toBe("external");
    expect(r.doc.sourceUri).toBe("https://example.com/doc");
  });

  it("defaults to first_party when nothing is carried in", async () => {
    const r = await run(await fixture("structured.md"), "text/markdown");
    expect(r.doc.trust).toBe("first_party");
    expect(r.doc.acl.public).toBe(false);
  });
});

// Tesseract downloads ~15MB of language data on first use. That is a poor
// thing to put in every CI run, so the real OCR pass is opt-in:
//   RUN_OCR_TESTS=1 pnpm test
const ocrIt = process.env.RUN_OCR_TESTS === "1" ? it : it.skip;

describe("pdf OCR fallback", () => {
  ocrIt("reads a scanned page that has no text layer", { timeout: 120_000 }, async () => {
    const r = await run(await fixture("scanned.pdf"), "application/pdf", "scanned.pdf");
    expect(r.stats.ocrPages).toBe(1);
    expect(r.doc.markdown.toLowerCase()).toContain("scanned document");
    expect(r.doc.markdown.toLowerCase()).toContain("ocr must recover");
    expect(r.stats.meanOcrConfidence as number).toBeGreaterThan(60);
  });
});
