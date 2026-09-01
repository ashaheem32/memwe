import { describe, expect, it } from "vitest";
import { normalizeText } from "../apps/worker/src/extract/normalize.js";
import { resolveSpan, SpanMap } from "../apps/worker/src/extract/spans.js";

const run = (raw: string, opts = {}) => {
  const map = new SpanMap();
  const text = normalizeText(raw, map, 0, opts);
  return { text, entries: map.toJSON() };
};

describe("normalization", () => {
  it("expands ligatures so search and embedding see real words", () => {
    // A PDF that renders "efficient" as U+FB03 is invisible to a keyword
    // search for "efficient" and embeds differently from the same word.
    expect(run("eﬃcient ﬁle ﬂow").text).toBe("efficient file flow");
  });

  it("applies NFC so the two spellings of é match", () => {
    const decomposed = "café"; // e + combining acute
    const { text } = run(decomposed);
    expect(text).toBe("café".normalize("NFC"));
    expect(text.length).toBe(4);
  });

  it("removes soft hyphens and zero-width spaces", () => {
    expect(run("re­trie​val").text).toBe("retrieval");
  });

  it("preserves ZWJ and ZWNJ — they are semantic, not invisible junk", () => {
    // Stripping U+200D turns a family emoji into four separate people, and
    // breaks Arabic and Devanagari shaping.
    const family = "👨‍👩‍👧‍👦";
    const arabic = "بسم‌الله";
    expect(run(family).text).toBe(family);
    expect(run(arabic).text).toBe(arabic);
  });

  it("normalises exotic spaces to plain ones", () => {
    expect(run("a b c").text).toBe("a b c");
  });

  it("collapses runs of blank lines to a single paragraph break", () => {
    expect(run("a\n\n\n\n\n\nb").text).toBe("a\n\nb");
    expect(run("a\n\nb").text).toBe("a\n\nb");
    expect(run("a\nb").text).toBe("a\nb");
  });

  it("strips trailing whitespace and trailing blank lines", () => {
    expect(run("a   \nb\t\n\n\n").text).toBe("a\nb");
  });

  describe("de-hyphenation", () => {
    it("joins a word broken across a line break", () => {
      expect(run("extrac-\ntion works", { dehyphenate: true }).text).toBe("extraction works");
    });

    it("leaves a real compound alone", () => {
      // "well-\nKnown" continues with a capital, so the hyphen is authorial.
      expect(run("well-\nKnown thing", { dehyphenate: true }).text).toContain("well-");
    });

    it("is off by default, because markdown line breaks are authored", () => {
      expect(run("extrac-\ntion").text).toBe("extrac-\ntion");
    });
  });

  describe("offset tracking", () => {
    it("records the shift a CRLF collapse causes", () => {
      const { text, entries } = run("one\r\ntwo\r\nthree");
      expect(text).toBe("one\ntwo\nthree");
      const last = entries.at(-1);
      expect(last).toBeDefined();
      // Two CRLFs collapsed, so the source is two characters ahead by the
      // last line. A map that ignored this points at the wrong characters
      // for every Windows-authored document.
      expect(last!.src - last!.md).toBe(2);
    });

    it("resolves a span back through that shift", () => {
      const map = new SpanMap();
      const raw = "alpha\r\nbravo\r\ncharlie";
      const text = normalizeText(raw, map, 0);
      const at = text.indexOf("charlie");
      const [loc] = resolveSpan(map.toJSON(), at, at + 7, { markdownLength: text.length });
      expect(loc).toBeDefined();
      expect(raw.slice(loc!.srcStart, loc!.srcEnd)).toBe("charlie");
    });
  });
});

describe("resolveSpan", () => {
  const entries = [
    { md: 0, src: 0, page: 1 },
    { md: 10, src: 30, page: 2 },
    { md: 20, src: 100, page: 3 },
  ];

  it("returns nothing for an empty or inverted range", () => {
    expect(resolveSpan(entries, 5, 5)).toEqual([]);
    expect(resolveSpan(entries, 9, 3)).toEqual([]);
    expect(resolveSpan([], 0, 10)).toEqual([]);
  });

  it("maps a range inside one segment", () => {
    const [loc] = resolveSpan(entries, 2, 6, { markdownLength: 30 });
    expect(loc).toMatchObject({ srcStart: 2, srcEnd: 6, page: 1 });
  });

  it("splits a range that straddles segments", () => {
    // A chunk crossing a page boundary must cite both pages, not pick one.
    const locs = resolveSpan(entries, 8, 14, { markdownLength: 30 });
    expect(locs.map((l) => l.page)).toEqual([1, 2]);
    expect(locs[0]).toMatchObject({ srcStart: 8, srcEnd: 10 });
    expect(locs[1]).toMatchObject({ srcStart: 30, srcEnd: 34 });
  });

  it("covers every segment a wide range touches", () => {
    expect(resolveSpan(entries, 0, 30, { markdownLength: 30 }).map((l) => l.page)).toEqual([
      1, 2, 3,
    ]);
  });
});
