/**
 * Split markdown into atomic blocks — the smallest units a chunk boundary
 * may fall between. Splitting inside one of these is what produces a chunk
 * containing half a code fence or three cells of a table.
 */
export type BlockType = "heading" | "paragraph" | "code" | "list" | "table" | "quote";

export type Block = {
  type: BlockType;
  text: string;
  /** Offsets into the document markdown. Carried onto the chunk for provenance. */
  start: number;
  end: number;
  /** Enclosing headings, outermost first. */
  path: string[];
  level?: number;
};

const ATX = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const LIST = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+/;
const TABLE = /^\s{0,3}\|/;
const QUOTE = /^\s{0,3}>/;

export function toBlocks(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  const headings: Array<{ level: number; heading: string }> = [];
  let path: string[] = [];

  let offset = 0;
  let i = 0;

  const lineStart: number[] = [];
  for (const line of lines) {
    lineStart.push(offset);
    offset += line.length + 1;
  }
  const startOf = (n: number) => lineStart[n] ?? markdown.length;
  const endOf = (n: number) => Math.min(startOf(n) + (lines[n]?.length ?? 0), markdown.length);

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i++;
      continue;
    }

    // A fence is atomic even though it contains blank lines and text that
    // looks like headings or lists.
    const fence = FENCE.exec(line);
    if (fence?.[1]) {
      const marker = fence[1];
      const from = i;
      i++;
      const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \t]*$`);
      while (i < lines.length && !close.test(lines[i] ?? "")) i++;
      if (i < lines.length) i++; // closing fence
      blocks.push({
        type: "code",
        text: lines.slice(from, i).join("\n"),
        start: startOf(from),
        end: endOf(i - 1),
        path: [...path],
      });
      continue;
    }

    const heading = ATX.exec(line);
    if (heading?.[1] && heading[2]) {
      const level = heading[1].length;
      while (headings.length && headings.at(-1)!.level >= level) headings.pop();
      headings.push({ level, heading: heading[2] });
      path = headings.map((h) => h.heading);
      blocks.push({
        type: "heading",
        text: line,
        start: startOf(i),
        end: endOf(i),
        path: [...path],
        level,
      });
      i++;
      continue;
    }

    // Runs of like lines group together: a list is one block, not one per item.
    const kind: BlockType = TABLE.test(line)
      ? "table"
      : LIST.test(line)
        ? "list"
        : QUOTE.test(line)
          ? "quote"
          : "paragraph";
    const matcher =
      kind === "table" ? TABLE : kind === "list" ? LIST : kind === "quote" ? QUOTE : null;

    const from = i;
    i++;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (next.trim() === "") break;
      if (ATX.test(next) || FENCE.test(next)) break;
      // A paragraph absorbs continuation lines; a list or table only
      // absorbs lines that still look like one.
      if (matcher && !matcher.test(next) && !/^\s{2,}\S/.test(next)) break;
      if (!matcher && (LIST.test(next) || TABLE.test(next) || QUOTE.test(next))) break;
      i++;
    }

    blocks.push({
      type: kind,
      text: lines.slice(from, i).join("\n"),
      start: startOf(from),
      end: endOf(i - 1),
      path: [...path],
    });
  }

  return blocks;
}
