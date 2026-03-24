# CLAUDE.md — Project Instructions

## Project Overview

This is a TypeScript CLI tool that decodes BMW TIS `.ITW` proprietary image files into standard PNG. The format was reverse-engineered from `tis.exe` using Ghidra (live MCP connection) and Binary Ninja (static HLIL dump). Two compression codecs are supported: wavelet (0x0300) and entropy (0x0400).

## Build & Run

```bash
# Install dependencies
pnpm install

# Decode a single file
./node_modules/.bin/ts-node src/index.ts samples/1/03/95/26.ITW -o output.png

# Bulk test against corpus
./node_modules/.bin/ts-node bulk_test.ts /Volumes/emdzej/Documents/tis/GRAFIK --limit 100
```

**Important:**
- Use `pnpm` (not npm) for package management
- Use `./node_modules/.bin/ts-node` (not `npx ts-node` — doesn't work in this environment)
- The CLI uses `-o` flag for output path

## Source Structure

```
src/itw.ts          — Header parsing, shared types (ITWHeader, DecodeResult, ITWError), BE16/BE32/LE32 helpers
src/decode0300.ts   — Wavelet codec decoder (~1518 lines)
src/decode0400.ts   — Entropy codec decoder (fully working, pixel-perfect)
src/png.ts          — Grayscale→RGBA conversion + PNG writer (pngjs)
src/index.ts        — CLI entry point
docs/findings.md    — Comprehensive RE documentation
bulk_test.ts        — Corpus-wide test script
```

## Key API Conventions

- `parseHeader()` returns `{ header: ITWHeader; payloadOffset: number }` — access width/height via `.header.width`, `.header.height`
- `decode0300(buf, payloadOffset, width, height, opts?)` — NOT `decode0300(buf, header, payloadOffset, opts?)`
- `decode0400(buf, payloadOffset, width, height)` — same pattern
- Both decoders return `DecodeResult` (pixels Uint8Array + width/height)

## Reverse Engineering Workflow

### Ghidra MCP (Primary)
A Ghidra MCP server runs at localhost:8080 providing live decompilation/disassembly of `tis.exe`. Use the Ghidra tools (`ghidra_decompile_function`, `ghidra_disassemble_function`, `ghidra_search_functions_by_name`, etc.) to inspect functions.

**Functions have been renamed** — use human-readable names like `coeff_reconstruct_quant2`, `level_scale_factor`, `wavelet_init_filters`, etc. Don't use raw addresses like `FUN_004b6c40`. See `docs/findings.md` section 4 for the full function name table.

### Binary Ninja HLIL (Secondary)
A static dump lives at `ref/tis.exe.txt` (258,956 lines). Use for cross-referencing when Ghidra's decompiler output seems suspicious.

### Critical Ghidra Pitfall
**Ghidra's decompiler gets x87 FPU instructions wrong.** For `FSUBRP`, `FDIVRP`, and other reverse variants, always verify with disassembly (`ghidra_disassemble_function`). The "reverse" variants compute `ST(1) op ST(0)` → result in `ST(1)`, and Ghidra sometimes gets the operand order wrong in its C pseudocode.

**HOWEVER:** For `FSUBRP` specifically (opcode `DE E1`), Intel manual says `FSUBRP ST(1), ST(0)` computes `ST(1) ← ST(0) - ST(1)` — meaning Ghidra's decompiler was actually CORRECT for some cases we initially thought were wrong.

## Key Ghidra Functions (use these names)

| Name | Address | Purpose |
|------|---------|---------|
| `wavelet_init_filters` | 004b7770 | Initialize filter coefficients |
| `filter_derive_mirror` | 004b7690 | Derive mirror filter (sign alternation) |
| `itw_decode_main` | 004b7970 | Main wavelet decode entry |
| `itw_decode_band` | 004b72b0 | Decode one wavelet subband |
| `coeff_reconstruct_quant2` | 004b6c40 | Dequantize coefficients |
| `wavelet_reconstruct_all` | 004bd1e0 | Reconstruct all pyramid levels |
| `wavelet_reconstruct_level` | 004bc640 | Reconstruct one level |
| `polyphase_convolve` | 004bc940 | Polyphase convolution (SET) |
| `FUN_004bcdc0` | 004bcdc0 | Polyphase convolution (ADD) |
| `fischer_decode` | (see decode0300.ts) | Fischer/Golomb rank coding |
| `calc_rank_bit_length` | 004b88a0 | Bit length for rank coding |
| `level_scale_factor` | 004b8a40 | Per-level scale factor |
| `q15_to_float` | 004bc0d0 | Q15 fixed-point → float |
| `read_ll_band` | 004bc130 | Read LL approximation band |
| `FUN_004b5b30` | 004b5b30 | Output: float→clamp→byte |

Full table in `docs/findings.md` section 4.

## RESOLVED: 2× Detail Gain Bug

**Root cause:** `deriveMirror()` second loop started with `sign = +1` instead of `-1`, flipping signs of filter coefficients above center. This made g1 (synthesis high) act as lowpass instead of highpass, leaking ~2× detail energy into the reconstruction.

**Fix:** One-line change — `sign = -1` in second loop (bug #9). MAD dropped from 9.84 to 2.90.

### Debug options in decode0300
The `decode0300` function accepts an `opts` parameter with these debug flags:
- `zeroDetailBands`: Zero all detail bands (LL-only output)
- `bandMask`: Bitmask to selectively enable/disable specific bands
- `returnFloat`: Return float pixel values before clamping
- `detailGain`: Uniform scale factor applied to all detail band coefficients
- `g1Scale`: Override scale factor for the g1 (synthesis high) filter

## Test Data

- `samples/1/03/95/` — 0x0300 wavelet: `00.ITW`, `26.ITW`, `30.ITW`, `60.ITW`, `83.ITW` (316×238)
- `samples/10/00/` — 0x0400 entropy samples
- `/Volumes/emdzej/Documents/tis/GRAFIK` — Full 47,660-file corpus (external drive, may not be mounted)

## ITW Format Quick Reference

### Header (14 bytes, all BE16)
```
0x00: "IT" (0x4954)    0x02: "W_" (0x575F)
0x04: version           0x06: width          0x08: height
0x0A: bpp (always 8)    0x0C: subtype (0x0300 or 0x0400)
```

### 0x0300 Wavelet
- 100% of corpus uses numLevels=4, filterType=1
- Both "analysis" filters are actually lowpass (DC sum = 1.0 each)
- All 4 filters scaled by √2 for filterType=1
- LL band stored column-major
- Bitstream is LSB-first

### 0x0400 Entropy
- Huffman + RLE interleave
- Table B/C are Huffman-encoded data streams
- Huffman leaf weights are LE32 IEEE 754 floats
- Interleave depth = 8

## Coding Conventions

- Guard against malformed inputs (some 0x0400 files have bogus lengths)
- Use `Math.fround()` for float32 precision matching TIS.exe's x87 FPU
- Use `Math.trunc()` for float-to-int conversion (matches ftol behavior)
- Diagnostic scripts use `diag_*.ts` naming pattern in project root

## Status

See @STATUS.md for current project status, test results, and open issues.
See @docs/findings.md for comprehensive reverse-engineering documentation.
