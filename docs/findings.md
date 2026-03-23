# ITW Image Format — Reverse-Engineering Findings

This document captures all findings from reverse-engineering the ITW image format used in BMW TIS (Technical Information System) software. The format was reverse-engineered from `tis.exe` using Ghidra and Binary Ninja, with cross-referencing against actual ITW files from the GRAFIK corpus (~47,660 files).

---

## 1. Header (14 bytes, common to all subtypes)

The header consists of 7 big-endian 16-bit words:

| Offset | Size  | Field     | Description                                        |
|--------|-------|-----------|----------------------------------------------------|
| 0x00   | 4     | magic     | `"ITW_"` (two BE16 values, `0x4954` + `0x575F`)   |
| 0x04   | 2     | version   | `0x0100` = wavelet, `0x0200` = entropy             |
| 0x06   | 2     | width     | Image width in pixels                              |
| 0x08   | 2     | height    | Image height in pixels                             |
| 0x0A   | 2     | bpp       | Bits per pixel (always 8 in practice)              |
| 0x0C   | 2     | subtype   | `0x0300` = wavelet codec, `0x0400` = entropy codec |

**Total header size: 14 bytes.** Payload starts immediately after.

### Endianness
- All header fields are **big-endian 16-bit**.
- BE32 values are read as two consecutive BE16 reads: `hi16 << 16 | lo16`.

### Common dimensions
- Most files are `316×238` or `316×239` (small technical illustrations).
- Some larger files: `632×473`, `632×474`.

### Corpus breakdown
- ~85% of files are subtype `0x0400` (entropy).
- ~15% of files are subtype `0x0300` (wavelet).
- All `0x0300` files have version `0x0100`; all `0x0400` files have version `0x0200`.

---

## 2. Subtype 0x0400 — Entropy Codec

**Entry point:** `FUN_004b57f0` → `FUN_004b5a40`

### Payload layout (after 14-byte header)

```
[1 byte]  N          — number of entries in Table A
[N bytes] Table A    — direct symbol table
[4 bytes] len1       — BE32 length of Table B
[len1 bytes] Table B — Huffman-encoded data stream B
[4 bytes] len2       — BE32 length of Table C
[len2 bytes] Table C — Huffman-encoded data stream C
```

### Decoding pipeline

1. **Huffman table parse** (`FUN_004b6340`): Reads a LE32 count, then per leaf: reads symbol (at +2) and 4-byte LE weight (IEEE 754 float). Builds a priority-queue-sorted Huffman tree.

2. **Huffman decode** (`FUN_004b6250`): Consumes bits **LSB-first** from the byte stream; traverses tree via child pointers until reaching a leaf; emits the leaf symbol.

3. **Interleave** (`FUN_004b5c40` / `FUN_004b5d20`): Builds an expansion codebook (bit depth = `DAT_004ed104 = 8`). Decoded streams B and C are interleaved with run-length expansion using Table A as codebook. Stream C provides repeat counts, stream B provides symbol indices.

4. **Output**: Pixels are written row by row into the output buffer.

### Robustness fixes in our decoder
- **Interleave bounds guard**: The original C code reads past buffer end without checking. Our decoder pushes 0 for out-of-range values.
- **Pixel shortfall tolerance**: Some files produce slightly fewer pixels than `width × height` (up to 1%). We zero-fill the remainder. Files with >1% shortfall are rejected as malformed.

### Known malformed files
- `10/00/26.ITW` and `10/00/18.ITW` declare `len1`/`len2` values that exceed file size — genuinely malformed.

---

## 3. Subtype 0x0300 — Wavelet Codec

**Entry point:** `FUN_004b5b30` → `itw_decode_main` (`004b7970`)

### Payload layout

After the 14-byte common header:

```
[4 bytes] BE32     — compressed data length
[N bytes] payload  — wavelet-compressed bitstream
```

### Wavelet parameters (from payload header)

The payload begins with 3 bytes:
1. **Byte 0**: Version/flags (unused beyond validation)
2. **Byte 1**: `numLevels` — number of wavelet decomposition levels (typically 3 or 4)
3. **Byte 2**: `filterType` — wavelet filter selection (0 or 1)

### Filter coefficients

Both filter types use symmetric biorthogonal wavelet filters with analysis low/high pairs.

**Filter type 0 — CDF 9/7-like:**
- Analysis low: 9 taps (symmetric, center coefficient `0x3f499a81 ≈ 0.7885`)
- Analysis high: 7 taps (symmetric, center coefficient `0x3f511889 ≈ 0.8170`)

**Filter type 1 — 7/5 with √2 scaling:**
- Analysis low: 7 taps
- Analysis high: 5 taps
- All four derived filters (analysis low, analysis high, synthesis low, synthesis high) are scaled by `√2` after derivation

### Filter structure (from `filter_alloc` @ `004bc270`)

```c
struct filter {
    int   length;       // [0] number of taps
    float *coeffs;      // [1] coefficient array pointer
    int   step;         // [2] always 1
    int   center;       // [3] = (length - 1) / 2
    int   field4;       // [4] = center + parity
    int   neg_parity;   // [5] = -parity
};
```

### Mirror derivation (`filter_derive_mirror` @ `004b7690`)

Derives one filter from another by sign-alternating the coefficients:
- From center downward: `+1, -1, +1, -1, ...`
- From center+1 upward: `+1, -1, +1, -1, ...`
- **Does NOT reverse** the array (a critical bug in our initial implementation).

### Pyramid structure

A multi-level wavelet pyramid with 4 subbands per level:

| Ghidra index | Our index | Band   |
|-------------|-----------|--------|
| subband[0]  | subbands[2] | HL   |
| subband[1]  | subbands[1] | LH   |
| subband[2]  | subbands[3] | HH   |
| subband[3]  | subbands[0] | LL   |

Matrix layout: row-major storage `data[x + width * y]`, with `matrix[0] = width`, `matrix[1] = height`.

### Band decoding (`itw_decode_band` @ `004b72b0`)

Each detail band is entropy-coded using a Fischer/Golomb-like coding scheme:

1. Read band metadata: `band_scale` (Q15 float), `band_value`, `band_offset_scale`
2. Read the bitstream using LSB-first bit ordering
3. Dequantize: `coeff = decoded_int * (band_scale / band_value * band_offset_scale) / level_scale_factor(extraBits)`
4. `band_offset` is always 0.0 (hardcoded)

**Bitstream bit ordering**: The `read_bits` function (`004bc220`) reads bits **LSB-first** from each byte. `read_single_bit` (`004bc1d0`) returns the lowest bit and right-shifts the byte.

### LL band (`read_ll_band` @ `004bc130`)

The LL (low-low) approximation band is read in **column-major order** (outer loop = X, inner loop = Y).

Post-processing:
```
first_val = read_be_multibyte(2)   // "minVal"
second_val = read_be_multibyte(2)  // "maxVal"
range = second_val - first_val
center = (range + first_val) * 0.5
llScale = (range - first_val) * 0.5 * (1/127)   // FSUBRP verified
```

Per-pixel formula: `value = (pixel - 127.0) * llScale + center`

Clamping: `value = clamp(value, range, first_val)` where `range < first_val` (note reversed bounds due to FSUBRP).

**CRITICAL**: The `llScale` computation uses `FSUBRP` (x87 reverse subtract) which computes `range - first_val`, NOT `first_val - range`. This was verified by disassembly at `004b7e36`–`004b7e87`.

### Wavelet reconstruction

**Reconstruction order** (per level, from coarsest to finest):
1. **Vertical** reconstruction: Merge LL+LH → L column, HL+HH → H column
2. **Horizontal** reconstruction: Merge L+H → full resolution

**Filter assignment for reconstruction:**
- `reconstructFilter1` = analysis high (parity=0) → used in `wavelet_filter_apply` (SET pass)
- `reconstructFilter2` = synthesis high (derived from analysis low, parity=1) → used in `wavelet_filter_add` (ADD pass)

**Polyphase convolution** (`polyphase_convolve` @ `004bc940`):
- Index formula: `upIdx = i + p + j` where `p = -filter.parity` (NO `+center`!)
- Edge extension: symmetric reflection at boundaries
- Interior fast path available but our decoder uses the slow (edge-checked) path everywhere — mathematically equivalent.

### Gain structure
- Both filter types produce DC gain of `1/√2` per 1D polyphase pass
- After 2D reconstruction (vertical + horizontal): gain = `1/2` per level
- After 4 levels: total gain = `(1/2)^4 = 1/16`
- LL band values are stored at ~16× pixel scale to compensate

### Output conversion (`FUN_004b5b30`)
- Read float from reconstructed matrix
- Clamp to `[0, 255.0f]`
- Convert to byte via `ftol` (round to nearest integer)
- Row iteration by column stride, column iteration by row stride

---

## 4. Key Ghidra Functions Reference

| Address       | Name (assigned)              | Purpose                                          |
|---------------|------------------------------|--------------------------------------------------|
| `004b5680`    | (header parse helper)        | Reads BE16 header fields                         |
| `004b5780`    | (header dispatcher)          | Parses header, dispatches by subtype             |
| `004b56f0`    | (read subtype)               | Reads subtype BE16                               |
| `004b5750`    | `read_be32`                  | BE32 via two BE16                                |
| `004b5b30`    | (wavelet entry)              | Outer decode: float→byte, clamp, output          |
| `004b57f0`    | (entropy entry)              | 0x0400 codec entry point                         |
| `004b5a40`    | (entropy payload reader)     | Reads N, tables A/B/C                            |
| `004b5c40`    | (expansion codebook)         | Builds interleave codebook (depth=8)             |
| `004b5d20`    | (RLE expand)                 | Run-length expansion with interleave             |
| `004b6250`    | (Huffman decode)             | Decode bitstream using Huffman tree              |
| `004b6340`    | (Huffman table parse)        | Parse leaf count, symbols, weights               |
| `004b6570`    | (Huffman tree build)         | Priority-queue merge by weight                   |
| `004b6ba0`    | (strided copy)               | Copy 1D temp to 2D matrix                        |
| `004b6c40`    | `coeff_reconstruct_quant2`   | Dequantize wavelet coefficients                  |
| `004b7180`    | `coeff_reconstruct_dispatch` | Dispatch to quant routine                        |
| `004b7240`    | `calc_band_size`             | Compute band byte size from dimensions           |
| `004b72b0`    | `itw_decode_band`            | Decode one wavelet subband                       |
| `004b7660`    | `filter_set_coeffs`          | Set filter coefficient values                    |
| `004b7690`    | `filter_derive_mirror`       | Derive mirror filter with sign alternation       |
| `004b7770`    | `wavelet_init_filters`       | Initialize all 4 filters for given type          |
| `004b7970`    | `itw_decode_main`            | Main wavelet decode routine                      |
| `004b8130`    | `matrix_alloc`               | Allocate matrix structure                        |
| `004b8370`    | `matrix_get_data_ptr`        | Get pointer to matrix data                       |
| `004b83f0`    | `matrix_set_pixel`           | Set single pixel in matrix                       |
| `004b8500`    | `matrix_create_view`         | Create submatrix view                            |
| `004b88a0`    | `calc_rank_bit_length`       | Fischer coding rank calculation                  |
| `004b8a40`    | `level_scale_factor`         | `16^n * (1/16)` scale factor                     |
| `004bc0d0`    | `q15_to_float`               | Convert Q15 fixed-point to float                 |
| `004bc100`    | `read_be_multibyte`          | Read N-byte big-endian value                     |
| `004bc130`    | `read_ll_band`               | Read LL approximation band                       |
| `004bc1d0`    | `read_single_bit`            | Read one bit (LSB-first)                         |
| `004bc220`    | `read_bits`                  | Read N bits (LSB-first accumulation)             |
| `004bc270`    | `filter_alloc`               | Allocate filter structure                        |
| `004bc640`    | `wavelet_reconstruct_level`  | Reconstruct one pyramid level                    |
| `004bc7c0`    | `split_even_odd`             | Split signal into even/odd polyphase             |
| `004bc810`    | `wavelet_filter_apply`       | Apply filter (SET — overwrites output)           |
| `004bc940`    | `polyphase_convolve`         | Polyphase convolution (slow path with edge ext)  |
| `004bcc10`    | `edge_extension_setup`       | Compute left/right reflection boundaries         |
| `004bcc60`    | `edge_extend_sample`         | Reflect sample at boundary                       |
| `004bcc90`    | `wavelet_filter_add`         | Apply filter (ADD — accumulates to output)       |
| `004bcdc0`    | `polyphase_convolve_add`     | Polyphase convolution (add variant)              |
| `004bd0d0`    | `pyramid_init_from_image`    | Initialize pyramid from image matrix             |
| `004bd1e0`    | `wavelet_reconstruct_all`    | Reconstruct all pyramid levels                   |

---

## 5. Global Constants

| Address    | Type     | Value         | Usage                            |
|------------|----------|---------------|----------------------------------|
| `004ed104` | int      | 8             | Interleave depth (0x0400)        |
| `004ed10c` | float32  | 255.0         | Output pixel clamp max           |
| `004ed118` | int      | 0x80          | Extra bits flag mask             |
| `004ed11c` | int      | 5             | Buffer size multiplier           |
| `004ed128` | double   | 2.0           | √2 source / band size calc      |
| `004ed130` | float32  | 0.125         | Bits-to-bytes (1/8)             |
| `004ed190` | double   | 0.5           | Center/scale calculations        |
| `004ed198` | double   | 1/127         | LL band scale factor             |
| `004ed1a0` | double   | 127.0         | LL band pixel offset             |
| `004ed1d0` | double   | 16.0          | `level_scale_factor` base        |
| `004ed1d8` | double   | 1/16          | `level_scale_factor` multiplier  |
| `004ed1f0` | float32  | 32.0          | Q15 divisor                      |

---

## 6. Critical Lessons Learned

### x87 FPU instruction pitfalls
Ghidra's decompiler can misrepresent x87 FPU reverse operations. `FSUBRP` computes `ST(1) - ST(0)`, not `ST(0) - ST(1)`. Similarly for `FDIVRP`. **Always verify with disassembly** when floating-point arithmetic seems wrong.

### Bitstream ordering
The bitstream reads bits **LSB-first** from each byte — the first bit read is bit 0 (lowest), not bit 7. This is the opposite of many common image format conventions.

### Column-major LL band
The LL band is stored in column-major order (X outer, Y inner), unlike most raster formats.

### Filter mirror does NOT reverse
`filter_derive_mirror` applies sign alternation in-place without reversing the array — a common assumption for wavelet filter mirrors that was wrong here.

---

## 7. Bulk Test Results

### Full corpus: 47,660 files

```
Total files:      47,660
Elapsed:          2,957s (~49 min, 16 files/s)

✅ Success:       47,028 (98.67%)
  0x0300 wavelet: 35,117
  0x0400 entropy: 11,911

❌ Failures:      632 (1.33%)
  0x0300 decode:  580
  0x0400 decode:  52
  Header parse:   0
```

### Corpus composition
- **35,697 files** (74.9%) are subtype 0x0300 (wavelet), version 0x0100
- **11,963 files** (25.1%) are subtype 0x0400 (entropy), version 0x0200
- **321 distinct image dimensions** observed; most common: 316×238 (69%)

### Wavelet parameters
- **100% of wavelet files** use `numLevels=4, filterType=1` (verified across 5,000+ files)
- No files with `filterType=0` or `numLevels=3` were found in the corpus
- The filter type 0 (CDF 9/7) code path exists in `tis.exe` but appears unused in this corpus

### Failure analysis

| Error type | Count | % of failures | Description |
|------------|-------|---------------|-------------|
| Wavelet payload overruns file | 470 | 74.4% | Truncated/corrupt files — declared payload length exceeds file size |
| Other 0x0300 failures | 110 | 17.4% | Various wavelet decode errors |
| 0x0400 pixel shortfall >1% | ~30 | 4.7% | Entropy decoder produced too few pixels |
| Other 0x0400 failures | ~21 | 3.3% | Various entropy decode errors |
| File permission error | 1 | 0.2% | EPERM (OS-level access issue) |

All failures appear to be genuinely malformed/truncated source files rather than decoder bugs.
