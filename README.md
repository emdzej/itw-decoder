# @emdzej/itw-decoder

TypeScript CLI decoder for BMW TIS `.ITW` proprietary image files. Converts proprietary ITW images to standard PNG format.

[![CI](https://github.com/emdzej/itw-decoder/actions/workflows/ci.yml/badge.svg)](https://github.com/emdzej/itw-decoder/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@emdzej/itw-decoder)](https://www.npmjs.com/package/@emdzej/itw-decoder)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)](LICENSE)

## What is ITW?

ITW is a proprietary image format used in BMW's Technical Information System (TIS) software for storing technical illustrations (wiring diagrams, exploded views, etc.). The format supports two compression codecs:

- **Subtype 0x0300** — Wavelet compression (biorthogonal wavelet transform, ~5:1–14:1 ratio)
- **Subtype 0x0400** — Entropy compression (Huffman + RLE interleave)

All images are 8-bit grayscale, typically 316×238 pixels.

For a full technical description of the format and decoding algorithms see [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md).

## Installation

### Global (recommended for CLI use)

```bash
npm install -g @emdzej/itw-decoder
```

### Local / development

```bash
pnpm install
```

## Usage

```
Usage: itw-decode [options] <input>

Decode BMW TIS .ITW proprietary image files to PNG

Arguments:
  input                  path to the .ITW file to decode

Options:
  -V, --version          output the current version
  -o, --output <file>    output PNG path (default: <input>.png in cwd)
  -d, --dir <directory>  output directory, keeps auto-derived filename (default: cwd)
  -h, --help             display help for command
```

### Examples

```bash
# Decode — output defaults to ./26.png
itw-decode samples/1/03/95/26.ITW

# Explicit output path
itw-decode samples/1/03/95/26.ITW -o out/diagram.png

# Write to a directory, keep original filename
itw-decode samples/1/03/95/26.ITW -d out/
```

> **Note:** `-o` and `-d` are independent; `-o` takes full precedence when both are supplied.

### Dev (without global install)

```bash
./node_modules/.bin/ts-node src/index.ts samples/1/03/95/26.ITW -o output.png
```

## Bulk testing

To test against a full GRAFIK corpus directory:

```bash
# First 100 files
./node_modules/.bin/ts-node bulk_test.ts /path/to/GRAFIK --limit 100

# All files
./node_modules/.bin/ts-node bulk_test.ts /path/to/GRAFIK
```

## Test results

Tested against the full 47,660-file GRAFIK corpus:

| Metric | Value |
|--------|-------|
| Success rate | **98.67%** (47,028 / 47,660) |
| 0x0300 wavelet decoded | 35,117 |
| 0x0400 entropy decoded | 11,911 |
| Failures | 632 — all genuinely malformed/truncated source files |

The dominant failure reason is "wavelet payload overruns file" (470 truncated files), not decoder bugs.

## Project structure

```
src/
  itw.ts          — Header parsing, shared types (ITWHeader, DecodeResult, ITWError), endian helpers
  decode0300.ts   — Wavelet codec (biorthogonal wavelet transform, ~1518 lines)
  decode0400.ts   — Entropy codec (Huffman + RLE interleave)
  png.ts          — Grayscale→RGBA conversion, PNG writer (pngjs)
  index.ts        — CLI entry point (commander.js)
docs/
  HOW_IT_WORKS.md — Complete decoder specification (format to reimplement in any language)
  findings.md     — Raw reverse-engineering notes, Ghidra function table, lessons learned
```

## Documentation

| Document | Description |
|----------|-------------|
| [`docs/HOW_IT_WORKS.md`](docs/HOW_IT_WORKS.md) | Complete, language-agnostic decoder specification — header layout, both codecs, filter derivation, Fischer coding, polyphase convolution, all constants |
| [`docs/findings.md`](docs/findings.md) | Reverse-engineering notes — Ghidra function addresses, all 9 bugs found and fixed, x87 FPU pitfalls |

## Building

```bash
pnpm build        # tsc → dist/
pnpm dev          # run via ts-node (no build step)
```

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — free for personal, research, and noncommercial use; commercial use is not permitted.
