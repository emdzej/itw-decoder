# itw-decoder

TypeScript CLI decoder for BMW TIS ITW image files. Converts proprietary ITW images to standard PNG format.

## What is ITW?

ITW is a proprietary image format used in BMW's Technical Information System (TIS) software for storing technical illustrations (wiring diagrams, exploded views, etc.). The format supports two compression codecs:

- **Subtype 0x0300** — Wavelet compression (biorthogonal wavelet transform, ~5:1–14:1 ratio)
- **Subtype 0x0400** — Entropy compression (Huffman + RLE interleave)

All images are 8-bit grayscale, typically 316×238 pixels.

## Installation

```bash
pnpm install
```

## Usage

```bash
# Decode a single file (output defaults to <input>.png)
pnpm run decode samples/10/00/32.ITW

# Decode with explicit output path
pnpm run decode samples/1/03/95/26.ITW -o out.png
```

## Bulk testing

To test against the full GRAFIK corpus:

```bash
# Test first 100 files
./node_modules/.bin/ts-node bulk_test.ts /path/to/GRAFIK --limit 100

# Test all files
./node_modules/.bin/ts-node bulk_test.ts /path/to/GRAFIK
```

## Project structure

```
src/
  itw.ts          — Header parsing, shared types, endian helpers
  decode0300.ts   — Wavelet codec decoder (biorthogonal wavelet transform)
  decode0400.ts   — Entropy codec decoder (Huffman + RLE)
  png.ts          — Grayscale→RGBA conversion, PNG writer (pngjs)
  index.ts        — CLI entry point
docs/
  findings.md     — Detailed reverse-engineering documentation
bulk_test.ts      — Corpus-wide bulk decoder test
```

## Format documentation

See [`docs/findings.md`](docs/findings.md) for comprehensive reverse-engineering notes including:
- Header layout and field descriptions
- Wavelet codec internals (filter coefficients, pyramid structure, bitstream format)
- Entropy codec internals (Huffman tables, interleave scheme)
- All key function addresses from `tis.exe`
- Critical implementation lessons learned

## Test results

- **98.67% success rate** across the full 47,660-file GRAFIK corpus (47,028 OK / 632 FAIL)
- 35,117 wavelet files and 11,911 entropy files decoded successfully
- All 632 failures are genuinely malformed/truncated source files (not decoder bugs)
- Dominant failure: "wavelet payload overruns file" (470 truncated files)

## License

Private research / reverse-engineering project.
