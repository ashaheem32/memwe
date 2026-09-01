/**
 * Decoding, with the span shift that decoding causes recorded rather than
 * ignored. Stripping a BOM and normalising CRLF both move every offset
 * after them; provenance that ignores that points at the wrong characters.
 */
export type Decoded = { text: string; encoding: string; bomStripped: boolean };

export function decode(bytes: Buffer): Decoded {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: bytes.subarray(3).toString("utf8"), encoding: "utf-8", bomStripped: true };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: bytes.subarray(2).toString("utf16le"), encoding: "utf-16le", bomStripped: true };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return { text: swapped.toString("utf16le"), encoding: "utf-16be", bomStripped: true };
  }

  const utf8 = bytes.toString("utf8");
  // U+FFFD only appears when decoding failed. A handful can be legitimate;
  // a spray of them means these bytes are not UTF-8.
  const replacements = (utf8.match(/�/g) ?? []).length;
  if (replacements > 0 && replacements / Math.max(utf8.length, 1) > 0.01) {
    return { text: bytes.toString("latin1"), encoding: "latin1", bomStripped: false };
  }
  return { text: utf8, encoding: "utf-8", bomStripped: false };
}
