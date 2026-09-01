# Fixture corpus

Every file that has ever broken the pipeline lives here. The point is not
coverage of happy paths — it is that Sprint 1's extractors meet the awkward
cases in CI rather than in production.

| File | What it exercises |
|---|---|
| `simple.pdf` | Two-page text-layer PDF with a real xref. Baseline extraction and per-page span locators. |
| `broken-xref.pdf` | Same document with `startxref` corrupted. Real-world PDFs are broken constantly; the extractor must repair, not reject. |
| `scanned.pdf` | Image-only PDF, zero-character text layer. The OCR fallback trigger. |
| `report.pdf` | Four pages with a running header, page-number footer, three font sizes, and a word broken across a line break. Exercises running-head removal, heading inference and de-hyphenation together. |
| `simple.docx` | OOXML zip. Must not be sniffed as `application/zip`. |
| `structured.md` | Deep heading tree + a fenced code block. Structural chunking must not split the fence. |
| `unicode.txt` | Emoji, RTL Arabic/Hebrew, Devanagari, combining marks, ZWJ sequences. Chunk boundaries must not split a grapheme cluster. |
| `empty.txt` | Zero bytes. Must fail the document, not the batch. |
| `actually-a-png.txt` | PNG bytes behind a `.txt` name. Proves we sniff content and never trust the extension. |
| *(generated)* `large.txt` | ~900KB, near the 1MB text cap. Built by the seed rather than committed. |

## Still needed — requires real-world files

- **A password-protected PDF**, to confirm it fails cleanly rather than hanging.
- **A PDF with a partial text layer** — a digital report with one scanned
  signature page. The per-page OCR decision handles it in principle; nothing
  proves it yet.
- **An audio file**, once transcription lands.

`simple.pdf`, `broken-xref.pdf` and `scanned.pdf` are generated, not sourced.
The generators live in the commit that added them; regenerate rather than
hand-edit, or the xref offsets stop matching.

Keep everything small. This directory is checked out on every CI run.
