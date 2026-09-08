import type { Section } from "@memwe/contracts";
import { MemweError } from "@memwe/contracts";
import { isProbablyReaderable, Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import type { Logger } from "../log.js";
import { normalizeLine } from "./normalize.js";
import { SpanMap } from "./spans.js";

/**
 * HTML -> markdown, with the boilerplate gone and every line traceable.
 *
 * Readability decides what the page is *about* and drops the navigation,
 * chrome, and related-links around it. The serializer below then walks what
 * is left and writes block structure — headings, lists, code, tables,
 * quotes — as markdown. Inline decoration (bold, links, code spans) is
 * deliberately not written: it would put characters in the markdown that
 * are not in the page, and the span map is only worth storing if a line of
 * markdown maps back to a line of the page exactly.
 *
 * The "source" for an HTML document is its page text: the readable text,
 * one block per line, in document order. It is derived deterministically
 * from the stored HTML snapshot, the same way PDF page text is derived from
 * the PDF, so a span resolves to a line of it and `/why` can show that line.
 */

export type HtmlInput = {
  bytes: Buffer;
  /** Base for relative links, and what Readability reports as the page. */
  url: string | null;
  /** Transport charset, when the server declared one. */
  charset: string | null;
};

export type HtmlResult = {
  title: string | null;
  markdown: string;
  spanMap: SpanMap;
  sections: Section[];
  /** ISO timestamp from the page's own published-time metadata, when present. */
  publishedAt: string | null;
  stats: {
    readable: boolean;
    byline: string | null;
    siteName: string | null;
    lang: string | null;
    excerpt: string | null;
    adopted: number;
    /** Characters of readable text kept vs. all text in the body. */
    keptChars: number;
    bodyChars: number;
    blocks: number;
  };
};

const BLOCKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

/** Elements whose text is never content. */
const SKIP = new Set([
  "audio",
  "button",
  "canvas",
  "embed",
  "head",
  "iframe",
  "img",
  "input",
  "link",
  "map",
  "meta",
  "noscript",
  "object",
  "picture",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "video",
]);

/** What goes when Readability cannot find an article: page chrome by name. */
const CHROME = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "svg",
  "canvas",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "dialog",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[role="dialog"]',
  '[aria-hidden="true"]',
  "[hidden]",
].join(",");

export function extractHtml(input: HtmlInput, log: Logger): HtmlResult {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => undefined); // CSS the parser dislikes is not our problem
  const dom = new JSDOM(input.bytes, {
    contentType: input.charset ? `text/html; charset=${input.charset}` : "text/html",
    virtualConsole,
    ...(input.url ? { url: input.url } : {}),
  });
  const document = dom.window.document;
  const bodyChars = collapse(document.body?.textContent ?? "").length;
  const lang = document.documentElement.getAttribute("lang")?.trim() || null;
  const metaTitle =
    document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() || null;

  // Code in reference pages links every keyword to its definition. To a
  // link-density heuristic that reads as navigation and the whole block goes
  // — the synopsis of a SQL reference page, for instance. The URLs are never
  // written out anyway, so unwrap them before anything scores the page.
  for (const a of document.querySelectorAll("pre a, code a")) a.replaceWith(...a.childNodes);

  // Readability edits the tree it is given, and we still need the original
  // for the fallback, so it works on a copy. It never gives up: on a page
  // with no article it returns the whole body, navigation included, so its
  // answer is only trusted when the page looked like an article going in
  // and the article it found is long enough to be one.
  const MIN_ARTICLE_CHARS = 250;
  const probably = isProbablyReaderable(document, { minContentLength: MIN_ARTICLE_CHARS });
  const article = new Readability(document.cloneNode(true) as Document, {
    charThreshold: MIN_ARTICLE_CHARS,
    // `language-*` classes on code blocks are the only classes we read.
    keepClasses: true,
  }).parse();
  let root: Element;
  let readable = false;
  let adopted = 0;
  if (probably && article?.content && (article.length ?? 0) >= MIN_ARTICLE_CHARS) {
    root = new JSDOM(article.content, {
      contentType: "text/html",
      virtualConsole,
      ...(input.url ? { url: input.url } : {}),
    }).window.document.body;
    adopted = adoptLeadingSiblings(document, root);
    readable = true;
  } else {
    log.info("no article found — stripping page chrome by name instead", {
      articleChars: article?.length ?? 0,
    });
    for (const el of document.querySelectorAll(CHROME)) el.remove();
    root = document.body;
  }
  const title =
    (article?.title?.trim() || metaTitle || document.title?.trim() || null)?.replace(/\s+/g, " ") ??
    null;

  const out = new Serializer();
  if (title) out.heading(title, 1);
  out.walk(root, { depth: 0, ordered: false, quote: 0, index: 0 });
  const { markdown, spanMap, sections, keptChars, blocks } = out.finish();
  if (markdown.trim().length === 0)
    throw new MemweError("unsupported_content", "page has no readable text");

  return {
    title,
    markdown,
    spanMap,
    sections,
    publishedAt: isoOrNull(article?.publishedTime),
    stats: {
      readable,
      /** Blocks before Readability's pick that were brought back in. */
      adopted,
      byline: article?.byline?.trim() || null,
      siteName: article?.siteName?.trim() || null,
      lang,
      excerpt: article?.excerpt?.trim() || null,
      keptChars,
      bodyChars,
      blocks,
    },
  };
}

/**
 * Readability scores by paragraphs, picks the best block, and keeps the
 * siblings after it that also score. What sits *before* the winner and has
 * no paragraphs — a reference page's title line and synopsis, a man page's
 * signature block — is dropped. Those are exactly the blocks a reader of
 * technical documentation came for. Find the winner in the original tree
 * and bring back the earlier siblings that carry a heading or code.
 */
function adoptLeadingSiblings(original: Document, articleRoot: Element): number {
  const page = articleRoot.firstElementChild; // Readability's #readability-page-1 wrapper
  const first = page?.firstElementChild;
  if (!page || !first) return 0;
  const anchor = findOriginal(original, first);
  if (!anchor?.parentElement) return 0;
  const leading: Element[] = [];
  for (let el = anchor.previousElementSibling; el; el = el.previousElementSibling) {
    if (el.matches(CHROME) || el.querySelector(CHROME)) continue;
    const hasStructure = el.querySelector("h1,h2,h3,h4,h5,h6,pre") !== null;
    if (!hasStructure) continue;
    if (collapse(el.textContent ?? "").length < 20) continue;
    leading.unshift(el);
  }
  // Insert before a fixed reference so document order survives.
  const ref = page.firstChild;
  for (const el of leading) page.insertBefore(el.cloneNode(true), ref);
  return leading.length;
}

/** The element in the original tree that Readability's first block came from. */
function findOriginal(original: Document, block: Element): Element | null {
  if (block.id) {
    const byId = original.getElementById(block.id);
    if (byId) return byId;
  }
  const wanted = collapse(block.textContent ?? "").slice(0, 200);
  if (wanted.length < 40) return null;
  for (const el of original.getElementsByTagName(block.tagName)) {
    if (collapse(el.textContent ?? "").startsWith(wanted)) return el;
  }
  return null;
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

type Ctx = { depth: number; ordered: boolean; quote: number; index: number };

/**
 * Emits markdown lines and page-text lines in lockstep. A markdown line
 * is `prefix + text`; its page-text line is `text`. The span map records
 * where each starts, and `exact` only when the two are the same characters.
 */
class Serializer {
  private readonly parts: string[] = [];
  private readonly map = new SpanMap();
  private readonly sections: Section[] = [];
  private md = 0;
  private src = 0;
  private blocks = 0;
  /** What the previous line was, to choose a single or double newline before the next. */
  private last: "none" | "item" | "code" | "row" | "block" = "none";
  private inline: string[] = [];

  heading(text: string, level: number, quote = 0): void {
    const line = normalizeLine(collapse(text));
    if (!line) return;
    // The page title is written first; a body heading that repeats it, at
    // whatever level the site uses for its title, is not a second section.
    if (this.sections.length === 1 && this.sections[0]?.heading === line) return;
    this.gap("block");
    const md = this.md;
    this.line(line, `${"> ".repeat(quote)}${"#".repeat(level)} `, false);
    this.sections.push({ heading: line, level, start: md, end: md });
  }

  walk(node: Node, ctx: Ctx): void {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === child.TEXT_NODE) {
        // Newlines in HTML source are whitespace; only <br> breaks a line.
        this.inline.push((child.textContent ?? "").replace(/\s+/g, " "));
        continue;
      }
      if (child.nodeType !== child.ELEMENT_NODE) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag)) continue;
      if (tag === "br") {
        this.inline.push("\n");
        continue;
      }
      if (!BLOCKS.has(tag)) {
        // Inline element: its text joins the current run.
        this.walk(el, ctx);
        continue;
      }
      this.flush(ctx);
      this.block(el, tag, ctx);
    }
    const tag = node.nodeType === node.ELEMENT_NODE ? (node as Element).tagName.toLowerCase() : "";
    if (tag === "body" || BLOCKS.has(tag)) this.flush(ctx);
  }

  private block(el: Element, tag: string, ctx: Ctx): void {
    const quote = "> ".repeat(ctx.quote);
    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        this.heading(el.textContent ?? "", Number(tag[1]), ctx.quote);
        return;
      case "pre":
        this.code(el, quote);
        return;
      case "blockquote":
        this.walk(el, { ...ctx, quote: ctx.quote + 1 });
        return;
      case "ul":
      case "ol": {
        // Items place their own gap: a single newline after another item,
        // a blank line after anything else.
        let index = 0;
        for (const li of Array.from(el.children)) {
          if (li.tagName.toLowerCase() !== "li") continue;
          index++;
          this.item(li, { depth: ctx.depth + 1, ordered: tag === "ol", quote: ctx.quote, index });
        }
        return;
      }
      case "table":
        this.table(el, quote);
        return;
      case "hr":
        this.gap("block");
        this.synthetic(`${quote}---`);
        return;
      case "li":
        // A stray li outside a list: treat as a paragraph.
        this.paragraphs(inlineText(el), quote, ctx);
        return;
      default:
        // Container or leaf block: recurse; runs of inline content inside
        // become paragraphs when they hit the next block or the end.
        this.walk(el, ctx);
    }
  }

  private item(li: Element, ctx: Ctx): void {
    const indent = "  ".repeat(ctx.depth - 1);
    const marker = ctx.ordered ? `${ctx.index}. ` : "- ";
    // The item's own text is its inline content before the first block
    // child; a loose item's leading <p> counts as that text.
    const own: string[] = [];
    const rest: Node[] = [];
    for (const child of Array.from(li.childNodes)) {
      const tag =
        child.nodeType === child.ELEMENT_NODE ? (child as Element).tagName.toLowerCase() : "";
      if (SKIP.has(tag)) continue;
      if (tag && BLOCKS.has(tag)) {
        if (tag === "p" && rest.length === 0 && own.join("").trim().length === 0)
          own.push(inlineText(child));
        else rest.push(child);
      } else if (rest.length === 0) own.push(inlineText(child));
      else rest.push(child);
    }
    const lines = splitLines(own.join(""));
    this.gap(this.last === "item" ? "item" : "block");
    const quote = "> ".repeat(ctx.quote);
    if (lines.length === 0) this.synthetic(`${quote}${indent}${marker}`.trimEnd());
    for (const [i, line] of lines.entries()) {
      if (i > 0) this.gap("item");
      this.line(line, `${quote}${indent}${i === 0 ? marker : " ".repeat(marker.length)}`, false);
    }
    this.last = "item";
    // Whatever follows: nested lists and blocks dispatch as blocks, inline
    // runs become indented paragraphs.
    for (const n of rest) {
      if (n.nodeType === n.ELEMENT_NODE) {
        const tag = (n as Element).tagName.toLowerCase();
        if (BLOCKS.has(tag)) {
          this.flush(ctx);
          this.block(n as Element, tag, ctx);
        } else this.walk(n, ctx);
      } else if (n.nodeType === n.TEXT_NODE) {
        this.inline.push((n.textContent ?? "").replace(/\s+/g, " "));
      }
    }
    this.flush(ctx);
    this.last = "item";
  }

  private code(pre: Element, quote: string): void {
    const raw = (pre.textContent ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    if (raw.trim().length === 0) return;
    const codeEl = pre.querySelector("code");
    const lang =
      /language-([\w+-]+)/.exec(`${pre.className} ${codeEl?.className ?? ""}`)?.[1] ?? "";
    this.gap("block");
    this.synthetic(`${quote}\`\`\`${lang}`);
    for (const line of raw.split("\n")) {
      this.gap("code");
      // Verbatim: code is the one place whitespace is content.
      this.line(line, quote, true);
    }
    this.gap("code");
    this.synthetic(`${quote}\`\`\``);
    this.last = "block";
  }

  private table(table: Element, quote: string): void {
    const rows = Array.from(table.querySelectorAll("tr")).filter(
      (tr) => tr.closest("table") === table,
    );
    if (rows.length === 0) return;
    this.gap("block");
    for (const [i, tr] of rows.entries()) {
      const cells = Array.from(tr.children)
        .filter((c) => /^t[hd]$/i.test(c.tagName))
        .map((c) => normalizeLine(collapse(c.textContent ?? "")).replace(/\|/g, "\\|"));
      if (i > 0) this.gap("row");
      this.line(cells.join(" | "), `${quote}| `, false, " |");
      if (i === 0) {
        this.gap("row");
        this.synthetic(`${quote}| ${cells.map(() => "---").join(" | ")} |`);
      }
    }
    this.last = "block";
  }

  private paragraphs(text: string, quote: string, ctx: Ctx): void {
    const lines = splitLines(text);
    if (lines.length === 0) return;
    this.gap(ctx.depth > 0 ? "item" : "block");
    for (const [i, line] of lines.entries()) {
      if (i > 0) this.gap("item");
      this.line(line, `${quote}${"  ".repeat(ctx.depth)}`, false);
    }
    this.last = ctx.depth > 0 ? "item" : "block";
  }

  private flush(ctx: Ctx): void {
    const text = this.inline.join("");
    this.inline = [];
    this.paragraphs(text, "> ".repeat(ctx.quote), ctx);
  }

  /** One markdown line whose text is one page-text line. */
  private line(text: string, prefix: string, verbatim: boolean, suffix = ""): void {
    const source = verbatim ? text : normalizeLine(text);
    const rendered = `${prefix}${source}${suffix}`;
    this.map.mark(this.md, this.src, {
      mdEnd: this.md + rendered.length,
      srcEnd: this.src + source.length,
      exact: prefix === "" && suffix === "",
    });
    this.parts.push(rendered);
    this.md += rendered.length;
    this.src += source.length + 1; // the page-text newline
    this.blocks++;
  }

  /** Markdown with no page text behind it: fences, rules, table separators. */
  private synthetic(rendered: string): void {
    this.map.mark(this.md, this.src, {
      mdEnd: this.md + rendered.length,
      srcEnd: this.src,
      exact: false,
    });
    this.parts.push(rendered);
    this.md += rendered.length;
  }

  private gap(kind: "block" | "item" | "code" | "row"): void {
    if (this.last === "none") {
      this.last = kind;
      return;
    }
    const sep = kind === "block" ? "\n\n" : "\n";
    this.parts.push(sep);
    this.md += sep.length;
    this.last = kind;
  }

  finish() {
    for (let i = 0; i < this.sections.length; i++) {
      const current = this.sections[i]!;
      const next = this.sections.slice(i + 1).find((s) => s.level <= current.level);
      current.end = next ? next.start : this.md;
    }
    return {
      markdown: this.parts.join(""),
      spanMap: this.map,
      sections: this.sections,
      keptChars: this.src,
      blocks: this.blocks,
    };
  }
}

/** Text of a node with <br> as a newline and every other whitespace run as a space. */
function inlineText(node: Node): string {
  if (node.nodeType === node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
  if (node.nodeType !== node.ELEMENT_NODE) return "";
  const tag = (node as Element).tagName.toLowerCase();
  if (SKIP.has(tag)) return "";
  if (tag === "br") return "\n";
  return Array.from(node.childNodes).map(inlineText).join("");
}

/** Inline text -> page-text lines: `<br>` breaks, everything else collapses. */
function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => normalizeLine(collapse(l)))
    .filter((l) => l.length > 0);
}
