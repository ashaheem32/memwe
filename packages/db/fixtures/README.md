# Fixture corpus

Every file that has ever broken the pipeline lives here. The point is not
coverage of happy paths — it is that Sprint 1's extractors meet the awkward
cases in CI rather than in production.

| File | What it exercises |
|---|---|
| `simple.pdf` | Text-layer PDF. Baseline extraction. |
| `simple.docx` | OOXML zip. Must not be sniffed as `application/zip`. |
| `structured.md` | Deep heading tree + a fenced code block. Structural chunking must not split the fence. |
| `unicode.txt` | Emoji, RTL Arabic/Hebrew, Devanagari, combining marks, ZWJ sequences. Chunk boundaries must not split a grapheme cluster. |
| `empty.txt` | Zero bytes. Must fail the document, not the batch. |
| `actually-a-png.txt` | PNG bytes behind a `.txt` name. Proves we sniff content and never trust the extension. |
| *(generated)* `large.txt` | ~900KB, near the 1MB text cap. Built by the seed rather than committed. |

## Still needed — requires real-world files

- **A scanned, image-only PDF.** The OCR path is a different code path from
  the text-layer path and this corpus does not currently exercise it. Drop
  any scanned document in as `scanned.pdf` before Sprint 1's PDF work.
- **A password-protected PDF**, to confirm it fails cleanly rather than hanging.
- **An audio file**, once transcription lands.

Keep everything small. This directory is checked out on every CI run.
