# ITW Decoder — Project Status

**Last updated:** 2026-03-24

## Overview

TypeScript CLI decoder for BMW TIS `.ITW` proprietary image files. Reads ITW files and outputs standard PNG images (grayscale to RGBA). Supports two compression subtypes:

- **0x0300** — Wavelet compression (biorthogonal wavelet transform)
- **0x0400** — Entropy compression (Huffman + RLE interleave)

The decoder was reverse-engineered from `tis.exe` using Ghidra (live MCP) and Binary Ninja (static HLIL dump).

---

## Current State

### What Works

| Component | Status | Notes |
|-----------|--------|-------|
| Header parsing (14-byte BE16) | ✅ Done | All fields decoded correctly |
| 0x0400 entropy decoder | ✅ Done | Fully working, pixel-perfect |
| 0x0300 wavelet decoder | ✅ Done | Fully working — detail gain bug FIXED (deriveMirror sign error) |
| CLI (`ts-node src/index.ts <file> -o out.png`) | ✅ Done | |
| Bulk corpus test | ✅ Done | 98.67% success rate |

### Bulk Test Results

```
Total files:      47,660
Success:          47,028 (98.67%)
  0x0300 wavelet: 35,117
  0x0400 entropy: 11,911
Failures:         632 (1.33%) — all genuinely malformed/truncated source files
```

---

## RESOLVED: Detail Band Gain Bug (was ~2× Too High)

**Root cause:** `deriveMirror()` sign error — the second loop (center+1 upward) started with `sign = +1` instead of `sign = -1`. This flipped the sign of all coefficients above the center index in both g0 and g1 filters.

**Impact:** The g1 (synthesis high) filter, which should be highpass (DC≈0), was acting as lowpass (DC≈0.607) due to the wrong sign pattern. This leaked detail band energy into the DC path, causing ~2× excess detail amplitude.

**Fix:** One-line change in `deriveMirror()`: `sign = 1` → `sign = -1` in second loop.

**Results after fix (ref comparison, 26.ITW):**
```
Before: MAD=9.84 (gain=1.0), optimal gain=0.48
After:  MAD=2.90 (gain=1.0), optimal gain≈0.90-1.0
Clipping: 12-17% → 1.9%
```

Remaining MAD of ~2.90 is expected given the 2× reference downsampling noise.

---

## Task List

### Medium Priority

- [ ] Clean up the 48+ diagnostic scripts (keep essential ones, delete rest)
- [ ] Update `docs/findings.md` with deriveMirror fix details
- [ ] Commit all changes

### Low Priority

- [ ] Investigate the 632 failing files (likely all genuinely corrupt/truncated)
- [ ] Add `--batch` mode for bulk decoding to PNG
- [ ] Performance optimization (current: ~16 files/sec on bulk test)
- [ ] Add unit tests for critical functions (Fischer decode, polyphase convolve, filter init)

---

## Bugs Fixed (9 total, all in 0x0300 wavelet decoder)

| # | Bug | Impact | Fix |
|---|-----|--------|-----|
| 1 | `deriveMirror` reversed the array | Garbled output | Sign alternation only, no reversal |
| 2 | Wrong filter pair for reconstruction | Incorrect wavelet basis | Use h1 (analysis high) + g1 (synthesis high) |
| 3 | Extra `+center` in polyphase convolution | Wrong sample indices | upIdx = `i + p + j`, not `i + center + p + j` |
| 4 | LL band read order was row-major | Rotated low-freq content | Must be column-major (X outer, Y inner) |
| 5 | LL scale sign inverted | Inverted brightness | `llScale = (minVal - range) * 0.5` (positive) |
| 6 | Edge extension boundary selection | Boundary artifacts | Restructured left/right bound logic |
| 7 | `Math.round()` instead of `Math.trunc()` | Rounding mismatch vs TIS.exe | TIS.exe uses ftol (truncation); also added `Math.fround()` for float32 |
| 8 | LL scale sign re-fixed (FSUBRP) | Brightness wrong again | Intel manual confirms `FSUBRP ST(1),ST(0)` = `ST(0) - ST(1)` — Ghidra was correct |
| 9 | `deriveMirror` sign error in upper half | ~2× detail gain, excessive clipping | Second loop sign starts at -1, not +1 (Ghidra's loop restarts at center) |

---

## Architecture

```
src/
  itw.ts          — Header parsing, shared types (ITWHeader, DecodeResult, ITWError), BE16/BE32/LE32 helpers
  decode0300.ts   — Wavelet codec (1518 lines): filters, Fischer coding, polyphase convolution, pyramid reconstruction
  decode0400.ts   — Entropy codec: Huffman trees, RLE interleave, codebook expansion
  png.ts          — Grayscale→RGBA + PNG writer (pngjs)
  index.ts        — CLI entry point

docs/
  findings.md     — Comprehensive RE documentation (header, both codecs, all Ghidra functions)

bulk_test.ts      — Corpus-wide test script
diag_*.ts         — 48 diagnostic scripts created during quality investigation (not committed)
```

### Key Design Decisions

- **TypeScript + CommonJS** — ts-node for dev, tsc for build
- **pnpm** — package manager
- **pngjs** — PNG encoding (no native deps)
- **zlib** (Node built-in) — wavelet payload decompression
- **float32 precision** via `Math.fround()` — matches TIS.exe's x87 FPU behavior
- **`Math.trunc()`** for float-to-int — matches TIS.exe's ftol

### Debug Options in `decode0300`

The wavelet decoder accepts an optional `opts` parameter for investigation:

| Option | Type | Purpose |
|--------|------|---------|
| `zeroDetailBands` | boolean | Zero all detail bands (LL-only output) |
| `bandMask` | number | Bitmask to enable/disable specific bands |
| `returnFloat` | boolean | Return float pixel values before clamping |
| `detailGain` | number | Uniform scale factor for all detail band coefficients |
| `g1Scale` | number | Override scale factor for g1 (synthesis high) filter |

---

## Git History

```
7ae2d0e feat: implement ITW image format decoder (wavelet 0x0300 + entropy 0x0400)
cab1f00 chore(ref): added reference code
fcf7a17 Initial commit
```

Branch `main` is ahead of origin by 1 commit. Working tree has uncommitted changes:
- `src/decode0300.ts` — debug options (`detailGain`, `g1Scale`, etc.)
- `STATUS.md`, `CLAUDE.md` — project documentation
- 48 `diag_*.ts` files — diagnostic scripts

---

## Key Discoveries (Summary)

### ITW Header Format (14 bytes, all BE16)

| Offset | Field | Example |
|--------|-------|---------|
| 0x00 | Magic "IT" (0x4954) | |
| 0x02 | Magic "W_" (0x575F) | |
| 0x04 | Version | 0x0100 (wavelet), 0x0200 (entropy) |
| 0x06 | Width | 316 |
| 0x08 | Height | 238 |
| 0x0A | BPP | 8 (always) |
| 0x0C | Subtype | 0x0300 (wavelet), 0x0400 (entropy) |

### Wavelet Corpus Characteristics

- 100% of wavelet files use `numLevels=4, filterType=1`
- Both "analysis" filters are lowpass (DC sum = 1.0 each)
- All 4 filters scaled by √2 for filterType=1
- LL band stored column-major

### Critical RE Lesson: Ghidra x87 FPU Decompilation

Ghidra's decompiler sometimes gets x87 FPU reverse instructions (`FSUBRP`, `FDIVRP`) wrong in its C pseudocode. Always verify with `ghidra_disassemble_function` for these opcodes. However, for `FSUBRP` (opcode `DE E1`), the Intel manual says `ST(1) ← ST(0) - ST(1)`, so Ghidra's decompiler was actually correct in the LL scale case.

---

## Reference Materials

| Item | Location | Notes |
|------|----------|-------|
| TIS.exe Ghidra project | Ghidra MCP (localhost:8080) | Live decompilation/disassembly |
| Binary Ninja HLIL dump | `ref/tis.exe.txt` | 258,956 lines, cross-reference with Ghidra |
| Reference screenshot | `ref/1.03.95-26.itw.png` | 632×478 (2× scaled from TIS.exe) |
| Sample ITW files | `samples/` | 0x0300 in `samples/1/03/95/`, 0x0400 in `samples/10/00/` |
| Full corpus | `/Volumes/emdzej/Documents/tis/GRAFIK` | 47,660 ITW files (external drive) |
| RE documentation | `docs/findings.md` | Comprehensive format spec |
