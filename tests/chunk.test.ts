import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { toBlocks } from "../apps/worker/src/chunk/blocks.js";
import { chunkDocument, contextHeader } from "../apps/worker/src/chunk/index.js";
import { tokens, warmTokenizer } from "../apps/worker/src/chunk/tokens.js";
import { extract } from "../apps/worker/src/extract/index.js";
import { resolveSpan } from "../apps/worker/src/extract/spans.js";
import { logger } from "../apps/worker/src/log.js";

const FIXTURES = join(import.meta.dirname, "..", "packages", "db", "fixtures");
const quiet = logger({ svc: "test" });
const doc = (markdown: string, title: string | null = null) =>
  ({ title, markdown, sections: [] }) as never;

beforeAll(async () => {
  await warmTokenizer();
});

describe("block segmentation", () => {
  it("keeps a fenced block whole, including its blank lines and fake headings", () => {
    const md = "# Real\n\n```bash\n# not a heading\n\necho hi\n```\n\nAfter.\n";
    const kinds = toBlocks(md).map((b) => b.type);
    expect(kinds).toEqual(["heading", "code", "paragraph"]);
    const code = toBlocks(md).find((b) => b.type === "code");
    expect(code?.text).toContain("# not a heading");
    expect(code?.text).toContain("echo hi");
  });

  it("groups a list into one block rather than one per item", () => {
    const blocks = toBlocks("- one\n- two\n- three\n\npara\n");
    expect(blocks.map((b) => b.type)).toEqual(["list", "paragraph"]);
  });

  it("groups table rows together", () => {
    const blocks = toBlocks("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("table");
  });

  it("tracks the enclosing heading path", () => {
    const blocks = toBlocks("# A\n\n## B\n\ntext\n\n### C\n\nmore\n");
    const text = blocks.find((b) => b.text === "text");
    const more = blocks.find((b) => b.text === "more");
    expect(text?.path).toEqual(["A", "B"]);
    expect(more?.path).toEqual(["A", "B", "C"]);
  });

  it("pops back out when a shallower heading arrives", () => {
    const blocks = toBlocks("# A\n\n### Deep\n\nx\n\n## B\n\ny\n");
    expect(blocks.find((b) => b.text === "y")?.path).toEqual(["A", "B"]);
  });

  it("gives every block offsets that slice back to itself", () => {
    const md = "# A\n\npara one\n\n- a\n- b\n\n```\ncode\n```\n";
    for (const b of toBlocks(md)) {
      expect(md.slice(b.start, b.end)).toBe(b.text);
    }
  });
});

describe("chunking", () => {
  it("never splits a code fence", () => {
    // A chunk holding half a fence is unreadable and embeds as noise.
    const body = Array.from({ length: 40 }, (_, i) => `line ${i} of prose here.`).join(" ");
    const md = `# T\n\n${body}\n\n\`\`\`ts\n${"const x = 1;\n".repeat(30)}\`\`\`\n\n${body}\n`;
    const chunks = chunkDocument(doc(md), quiet, { target: 120 });
    for (const c of chunks) {
      expect((c.text.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  it("respects heading boundaries when the content is big enough", () => {
    const para = "Sentence about retrieval. ".repeat(30);
    const md = `# Doc\n\n## Alpha\n\n${para}\n\n## Beta\n\n${para}\n`;
    const chunks = chunkDocument(doc(md), quiet, { target: 200, min: 50 });
    const paths = chunks.map((c) => c.path.join("/"));
    expect(paths.some((p) => p.includes("Alpha"))).toBe(true);
    expect(paths.some((p) => p.includes("Beta"))).toBe(true);
    // No chunk mixes the two sections.
    expect(chunks.every((c) => !(c.text.includes("## Alpha") && c.text.includes("## Beta")))).toBe(
      true,
    );
  });

  it("merges a section too small to embed forward instead of emitting it alone", () => {
    // A heading with one line under it should not become a 12-token chunk
    // that matches every query and means nothing.
    const md = "# Doc\n\n## Tiny\n\nOne line.\n\n## Also tiny\n\nAnother line.\n";
    const chunks = chunkDocument(doc(md), quiet, { target: 600, min: 120 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("Tiny");
    expect(chunks[0]?.text).toContain("Also tiny");
  });

  it("folds a trailing remainder into the previous chunk", () => {
    // The last section has nothing after it to merge into, so without this
    // a document ends on a 20-token chunk that matches loosely and means
    // almost nothing.
    const para = "Sentence about retrieval systems here. ".repeat(40);
    const md = `# Doc\n\n## Big\n\n${para}\n\n## Tail\n\nOne short line.\n`;
    const chunks = chunkDocument(doc(md), quiet, { target: 300, min: 120, max: 900 });
    expect(chunks.every((c) => c.tokenCount >= 120)).toBe(true);
    expect(chunks[chunks.length - 1]?.text).toContain("One short line.");
  });

  it("keeps a trailing remainder separate when merging would breach the ceiling", () => {
    const para = "Sentence about retrieval systems here. ".repeat(40);
    const md = `# Doc\n\n## Big\n\n${para}\n\n## Tail\n\nShort.\n`;
    const chunks = chunkDocument(doc(md), quiet, { target: 300, min: 120, max: 310 });
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(400);
  });

  it("packs near the target and stays under the ceiling", () => {
    const md = `# Doc\n\n${"A sentence of roughly ten tokens goes here. ".repeat(400)}`;
    const chunks = chunkDocument(doc(md), quiet, { target: 600, max: 800 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(900);
    const median = chunks.map((c) => c.tokenCount).sort((a, b) => a - b)[
      Math.floor(chunks.length / 2)
    ];
    expect(median).toBeGreaterThan(300);
  });

  describe("overlap", () => {
    const long = `# Doc\n\n${"A sentence of roughly ten tokens goes here. ".repeat(400)}`;

    it("carries context across a budget split", () => {
      const chunks = chunkDocument(doc(long), quiet, { target: 600, overlap: 0.12 });
      const after = chunks.slice(1);
      expect(after.every((c) => c.overlapTokens > 0)).toBe(true);
      // Roughly 12% of the target, not exact — overlap lands on a sentence
      // boundary rather than mid-word.
      for (const c of after) {
        expect(c.overlapTokens).toBeLessThanOrEqual(Math.round(600 * 0.12) + 20);
      }
    });

    it("does not overlap across a heading, because that is a real boundary", () => {
      const para = "Sentence about retrieval. ".repeat(30);
      const md = `# Doc\n\n## Alpha\n\n${para}\n\n## Beta\n\n${para}\n`;
      const chunks = chunkDocument(doc(md), quiet, { target: 200, min: 50 });
      const beta = chunks.find((c) => c.text.includes("## Beta"));
      expect(beta?.overlapTokens).toBe(0);
    });

    it("can be turned off", () => {
      const chunks = chunkDocument(doc(long), quiet, { target: 600, overlap: 0 });
      expect(chunks.every((c) => c.overlapTokens === 0)).toBe(true);
    });
  });

  it("splits an oversized single block rather than truncating it", () => {
    // One paragraph, no sentence breaks, far over the ceiling. Content must
    // survive; only the boundaries are ugly.
    const md = `# Doc\n\n${"word ".repeat(3000)}`;
    const chunks = chunkDocument(doc(md), quiet, { target: 300, max: 400 });
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(500);
    const rejoined = chunks.map((c) => c.text).join(" ");
    expect(tokens.count(rejoined)).toBeGreaterThan(2500);
  });

  it("names the common ancestor when a chunk spans sibling sections", () => {
    const md = "# Doc\n\n## Parent\n\n### A\n\nx\n\n### B\n\ny\n";
    const chunks = chunkDocument(doc(md), quiet, { target: 600, min: 120 });
    // The chunk holds A and B, so calling it "B" would describe a third of
    // it — the parent they share is the honest answer.
    expect(chunks[0]?.path).toEqual(["Doc", "Parent"]);
  });

  it("builds a context header from the title and heading path", () => {
    const md = "# Doc\n\n## Alpha\n\n" + "Sentence. ".repeat(60);
    const d = doc(md, "My Document");
    const chunks = chunkDocument(d, quiet, { target: 200, min: 50 });
    expect(contextHeader(d, chunks[0]!)).toContain("My Document");
  });
});

describe("chunk provenance", () => {
  it("chunk offsets slice back to the document markdown", async () => {
    const bytes = await readFile(join(FIXTURES, "report.pdf"));
    const { doc: nd } = await extract(
      { bytes, declaredMime: "application/pdf", filename: "report.pdf" },
      quiet,
    );
    const chunks = chunkDocument(nd, quiet, { target: 120, min: 30 });
    for (const c of chunks) {
      expect(c.spanEnd).toBeGreaterThan(c.spanStart);
      expect(c.spanEnd).toBeLessThanOrEqual(nd.markdown.length);
    }
  });

  it("resolves a chunk all the way back to a PDF page", async () => {
    // The whole chain: chunk -> markdown offsets -> span map -> page + bbox.
    // This is what /why has to be able to do.
    const bytes = await readFile(join(FIXTURES, "report.pdf"));
    const { doc: nd } = await extract(
      { bytes, declaredMime: "application/pdf", filename: "report.pdf" },
      quiet,
    );
    const chunks = chunkDocument(nd, quiet, { target: 120, min: 30 });
    const target = chunks.find((c) => c.text.includes("Consolidation"));
    expect(target).toBeDefined();

    const locs = resolveSpan(nd.spanMap, target!.spanStart, target!.spanEnd, {
      markdownLength: nd.markdown.length,
    });
    expect(locs.length).toBeGreaterThan(0);
    expect(locs.some((l) => l.page === 3)).toBe(true);
    expect(locs.some((l) => l.bbox !== undefined)).toBe(true);
  });
});
