# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-03

### Fixed

- Tolerate 256-byte payload length overrun in wavelet (0x0300) files — 586 files in the BMW TIS corpus have a declared payload length exactly 256 bytes larger than the actual file data due to a systematic encoder bug; the decoder now accepts overruns up to 512 bytes instead of rejecting the file outright, improving corpus success rate from 98.67% to 99.66%

## [0.1.0] - 2026-03-24

### Added

- ITW file header parser — 14-byte big-endian format with magic, version, dimensions, BPP, and subtype fields
- Subtype `0x0300` wavelet decoder — biorthogonal 7/5 wavelet transform with Fischer combinatorial coding, polyphase convolution, and multi-level pyramid reconstruction
- Subtype `0x0400` entropy decoder — Huffman tree + RLE interleave pipeline, pixel-perfect output
- PNG writer — grayscale-to-RGBA conversion via `pngjs`
- CLI (`itw-decode`) built with commander.js:
  - `<input>` positional argument
  - `-o / --output <file>` — explicit output file path
  - `-d / --dir <directory>` — output directory, auto-derives filename from input
  - `-V / --version` — reads version from `package.json`
  - `-h / --help`
- Published as scoped npm package `@emdzej/itw-decoder` with global `itw-decode` binary
- GitHub Actions CI workflow — builds on every push and pull request
- GitHub Actions publish workflow — OIDC trusted publishing to npmjs on GitHub release (no secrets required)
- `docs/HOW_IT_WORKS.md` — complete language-agnostic decoder specification
- PolyForm Noncommercial License 1.0.0
