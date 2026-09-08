import { beforeAll, describe, expect, it } from "vitest";
import { chunkDocument } from "../apps/worker/src/chunk/index.js";
import { tokens, warmTokenizer } from "../apps/worker/src/chunk/tokens.js";
import { extract } from "../apps/worker/src/extract/index.js";
import { sectionTree } from "../apps/worker/src/extract/markdown.js";
import { normalizeText } from "../apps/worker/src/extract/normalize.js";
import { resolveSpan, SpanMap } from "../apps/worker/src/extract/spans.js";
import { logger } from "../apps/worker/src/log.js";

const log = logger({ svc: "provenance-test" });
beforeAll(warmTokenizer);
describe("normalization provenance", () => {
  it("reports enclosing source ranges, not false exactness, after Unicode rewriting", () => {
    for (const raw of ["ﬁsh after", "cafe\u0301 after", "a\u200bb after"]) {
      const map = new SpanMap(),
        markdown = normalizeText(raw, map);
      const locs = resolveSpan(map.toJSON(), markdown.indexOf("after"), markdown.length);
      expect(locs).toEqual([{ srcStart: 0, srcEnd: raw.length, exact: false }]);
    }
  });
  it("extracts UTF-16 through sniffing and measures BOM offsets in decoded code units", async () => {
    const bytes = Buffer.concat([Buffer.from([255, 254]), Buffer.from("Hello\r\n世界", "utf16le")]);
    const { doc } = await extract(
      { bytes, declaredMime: "text/plain", filename: "hello.txt" },
      log,
    );
    expect(doc.markdown).toBe("Hello\n世界");
    expect(resolveSpan(doc.spanMap, 6, 8)).toEqual([{ srcStart: 8, srcEnd: 10, exact: true }]);
  });
  it("preserves authored hard breaks and code contents", async () => {
    const raw = "# Heading\n\nHard break  \nnext\n\n```txt\nﬁle  \n\n\ncode\n```";
    const { doc } = await extract(
      { bytes: Buffer.from(raw), declaredMime: "text/markdown", filename: "code.md" },
      log,
    );
    expect(doc.markdown).toBe(raw);
  });
  it("stops resolution at the span-map cap", () => {
    const map = new SpanMap();
    for (let i = 0; i < 10005; i++)
      map.mark(i, i * 2, { mdEnd: i + 1, srcEnd: i * 2 + 1, exact: true });
    expect(map.truncated).toBe(10000);
    expect(resolveSpan(map.toJSON(), 10001, 10004)).toEqual([]);
  });
  it("does not close a long code fence on a shorter fence", () => {
    expect(sectionTree("````\n```\n# fake\n````\n# real").map((s) => s.heading)).toEqual(["real"]);
  });
});
describe("chunk size and source mapping", () => {
  it("honors the exact default ceiling with overlap", () => {
    const markdown = "A short sentence. ".repeat(1000);
    const chunks = chunkDocument({ title: null, markdown, sections: [] }, log);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(810);
      expect(chunk.tokenCount).toBe(tokens.count(chunk.text));
      for (const range of chunk.sourceRanges) {
        expect(chunk.text.slice(range.textStart, range.textEnd)).toBe(
          markdown.slice(range.spanStart, range.spanEnd),
        );
      }
    }
    expect(chunks.slice(1).every((c) => c.overlapTokens > 0)).toBe(true);
  });
  it("preserves code and Unicode source characters across hard splits", () => {
    for (const markdown of [
      "👨‍👩‍👧‍👦世界".repeat(300),
      "```ts\n" + 'const café = "🙂";  \n'.repeat(100) + "```",
    ]) {
      const chunks = chunkDocument({ title: null, markdown, sections: [] }, log, {
        target: 80,
        max: 100,
        min: 20,
      });
      expect(chunks.every((c) => c.tokenCount <= 100 && !c.text.includes("�"))).toBe(true);
      for (const chunk of chunks)
        for (const r of chunk.sourceRanges) {
          expect(chunk.text.slice(r.textStart, r.textEnd)).toBe(
            markdown.slice(r.spanStart, r.spanEnd),
          );
        }
      if (markdown.startsWith("```"))
        expect(chunks.every((c) => (c.text.match(/```/g) ?? []).length % 2 === 0)).toBe(true);
    }
  });
  it("uses the normalized section tree, including headings skipped in markdown", () => {
    const markdown = "First section text.\n\nSecond section text.";
    const sections = [
      { heading: "A", level: 1, start: 0, end: 21 },
      { heading: "B", level: 1, start: 21, end: markdown.length },
    ];
    const chunks = chunkDocument({ title: null, markdown, sections }, log, {
      target: 20,
      min: 2,
      max: 30,
    });
    expect(chunks.map((c) => c.path)).toEqual([["A"], ["B"]]);
  });
  it("rejects invalid chunk settings instead of looping", () => {
    expect(() =>
      chunkDocument({ title: null, markdown: "hello", sections: [] }, log, { target: 0 }),
    ).toThrow(/invalid/);
  });
});
