import type { NormalizedDoc } from "@memwe/contracts";

type Section = { heading: string; level: number; start: number; end: number };

const ATX = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Build the section tree. Chunking splits on this rather than on a token
 * count alone, which is what keeps a heading with the text beneath it.
 *
 * Fenced code is skipped, because `# not a heading` inside a bash block is
 * a comment, and treating it as structure splits the fence in half.
 */
export function sectionTree(md: string): Section[] {
  const lines = md.split("\n");
  const sections: Section[] = [];
  const open: Section[] = [];
  let offset = 0;
  let fence: string | null = null;

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;

    const f = FENCE.exec(line);
    if (f?.[1]) {
      if (fence === null) fence = f[1][0] ?? "`";
      else if (line.trimStart().startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const m = ATX.exec(line);
    if (!m?.[1] || !m[2]) continue;

    const level = m[1].length;
    // A heading closes every section at or below its level.
    while (open.length > 0 && (open[open.length - 1]?.level ?? 0) >= level) {
      const done = open.pop();
      if (done) {
        done.end = lineStart;
        sections.push(done);
      }
    }
    open.push({ heading: m[2], level, start: lineStart, end: md.length });
  }

  while (open.length > 0) {
    const done = open.pop();
    if (done) sections.push(done);
  }
  return sections.sort((a, b) => a.start - b.start);
}

/** First H1, else first heading of any level. */
export function titleFrom(sections: Section[]): string | null {
  const h1 = sections.find((s) => s.level === 1);
  if (h1) return h1.heading;
  return sections[0]?.heading ?? null;
}

export function extractMarkdown(text: string): Pick<NormalizedDoc, "sections"> & {
  title: string | null;
} {
  const sections = sectionTree(text);
  return { sections, title: titleFrom(sections) };
}
