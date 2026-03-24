# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Fixed

- `deriveMirror()` sign error in upper-half loop — second loop now starts at `sign = -1` instead of `+1`, resolving ~2× detail band gain and excessive clipping in wavelet output (MAD dropped from 9.84 to 2.90 vs reference)

[0.1.0]: https://github.com/emdzej/itw-decoder/releases/tag/v0.1.0
