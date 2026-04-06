# @emdzej/itw-decoder

TypeScript CLI decoder for BMW TIS `.ITW` proprietary image files. Converts proprietary ITW images to standard PNG format.

[![CI](https://github.com/emdzej/itw-decoder/actions/workflows/ci.yml/badge.svg)](https://github.com/emdzej/itw-decoder/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@emdzej/itw-decoder)](https://www.npmjs.com/package/@emdzej/itw-decoder)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)](LICENSE)

## What is ITW?

ITW is a proprietary image format used in BMW's Technical Information System (TIS) software for storing technical illustrations (wiring diagrams, exploded views, etc.). The format supports two compression codecs:

- **Subtype 0x0300** — Wavelet compression (biorthogonal wavelet transform, ~5:1–14:1 ratio)
- **Subtype 0x0400** — Entropy compression (Huffman + RLE interleave)

All images are 8-bit grayscale, typically 316×238 or 631×474 pixels.

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

## Support

If you find this project useful, consider [buying me a coffee](https://buymeacoffee.com/emdzej) ☕ or [sponsoring on GitHub](https://github.com/sponsors/emdzej).

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — free for personal, research, and noncommercial use; commercial use is not permitted.

## Right to Repair

The [Right to Repair](https://repair.eu) movement advocates for consumers' ability to fix the products they own — from electronics to vehicles — without being locked out by manufacturers through proprietary tools, paywalled documentation, or artificial restrictions.

**I build these tools because I believe repair is a fundamental right, not a privilege.**

Too often, service manuals, diagnostic software, and technical documentation are kept behind closed doors — unavailable to individuals even when they're willing to pay. This wasn't always the case. Products once shipped with schematics and repair guides as standard. The increasing complexity of modern technology doesn't change the fact that capable people exist who can — and should be allowed to — use that information.

These projects exist to preserve access to technical knowledge and ensure that owners aren't left at the mercy of vendors who may discontinue support, charge prohibitive fees, or simply refuse service.
