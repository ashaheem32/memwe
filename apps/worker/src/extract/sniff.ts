import { fileTypeFromBuffer } from "file-type";

/**
 * What we will actually treat the bytes as. Never the client's word:
 * `actually-a-png.txt` in the fixture corpus exists specifically to prove
 * that a lying extension does not get through.
 */
export type Detected = {
  kind: "text" | "markdown" | "pdf" | "unsupported";
  mime: string;
  /** Set when the declared type and the real bytes disagree. */
  declaredMismatch?: string;
};

const TEXTUAL = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/json",
  "text/csv",
]);

/** Heuristic: does this look like markdown rather than prose? */
function looksLikeMarkdown(text: string, filename: string | null): boolean {
  if (filename && /\.(md|markdown|mdx)$/i.test(filename)) return true;
  const head = text.slice(0, 4000);
  return (
    /^#{1,6}\s+\S/m.test(head) ||
    /^```/m.test(head) ||
    /^\s*[-*+]\s+\S/m.test(head) ||
    /\[[^\]]+\]\([^)]+\)/.test(head)
  );
}

/** Bytes that no text encoding should contain. */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    // C0 controls other than tab, LF, CR, FF
    if (b !== undefined && b < 0x09) return true;
  }
  return false;
}

export async function sniff(
  bytes: Buffer,
  declaredMime: string | null,
  filename: string | null,
): Promise<Detected> {
  if (bytes.length === 0) return { kind: "unsupported", mime: "application/x-empty" };

  const magic = await fileTypeFromBuffer(bytes);

  if (magic?.mime === "application/pdf" || bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    return {
      kind: "pdf",
      mime: "application/pdf",
      ...(declaredMime && declaredMime !== "application/pdf"
        ? { declaredMismatch: declaredMime }
        : {}),
    };
  }

  // file-type only recognises binary formats; text falls through with no
  // match, which is itself the signal.
  if (magic) {
    return {
      kind: "unsupported",
      mime: magic.mime,
      ...(declaredMime && declaredMime !== magic.mime ? { declaredMismatch: declaredMime } : {}),
    };
  }

  if (isBinary(bytes)) {
    return { kind: "unsupported", mime: declaredMime ?? "application/octet-stream" };
  }

  const preview = bytes.subarray(0, 8192).toString("utf8");
  const markdown =
    looksLikeMarkdown(preview, filename) ||
    (declaredMime !== null && /markdown/.test(declaredMime));

  return {
    kind: markdown ? "markdown" : "text",
    mime: markdown ? "text/markdown" : "text/plain",
    ...(declaredMime && !TEXTUAL.has(declaredMime) ? { declaredMismatch: declaredMime } : {}),
  };
}
