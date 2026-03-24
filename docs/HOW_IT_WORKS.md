# ITW Image Format — Complete Decoder Specification

This document describes the ITW image format and decoding algorithms in sufficient detail to reimplement a decoder in any programming language. The format was reverse-engineered from BMW TIS `tis.exe`.

---

## Table of Contents

1. [File Structure](#1-file-structure)
2. [Subtype 0x0400 — Entropy Codec](#2-subtype-0x0400--entropy-codec)
3. [Subtype 0x0300 — Wavelet Codec](#3-subtype-0x0300--wavelet-codec)
   - [Payload Layout](#31-payload-layout)
   - [Wavelet Filters](#32-wavelet-filters)
   - [Wavelet Pyramid](#33-wavelet-pyramid)
   - [Band Decoding](#34-band-decoding)
   - [Fischer Combinatorial Coding](#35-fischer-combinatorial-coding)
   - [LL Band](#36-ll-band)
   - [Wavelet Reconstruction](#37-wavelet-reconstruction)
   - [Output Conversion](#38-output-conversion)
4. [Constants Reference](#4-constants-reference)
5. [Rank Table (Hardcoded)](#5-rank-table-hardcoded)

---

## 1. File Structure

### Header (14 bytes)

All fields are **big-endian 16-bit** integers.

| Offset | Size | Field   | Description |
|--------|------|---------|-------------|
| 0x00   | 2    | magic1  | `0x4954` = ASCII `"IT"` |
| 0x02   | 2    | magic2  | `0x575F` = ASCII `"W_"` |
| 0x04   | 2    | version | `0x0100` (wavelet) or `0x0200` (entropy) |
| 0x06   | 2    | width   | Image width in pixels |
| 0x08   | 2    | height  | Image height in pixels |
| 0x0A   | 2    | bpp     | Bits per pixel (always 8) |
| 0x0C   | 2    | subtype | `0x0300` (wavelet) or `0x0400` (entropy) |

The payload starts immediately at offset **14**.

Output is always **8-bit grayscale** (one byte per pixel).

---

## 2. Subtype 0x0400 — Entropy Codec

### Payload Layout

```
[1 byte]   N           — symbol count for Table A
[N bytes]  Table A      — direct symbol table (N byte values)
[4 bytes]  len1 (BE32)  — compressed length of Table B
[len1 bytes] Table B    — Huffman-encoded stream B
[4 bytes]  len2 (BE32)  — compressed length of Table C
[len2 bytes] Table C    — Huffman-encoded stream C
```

BE32 is read as two consecutive BE16 values: `(hi16 << 16) | lo16`.

### Step 1: Parse Table A

Read byte `N`, then read `N` bytes. Store as an integer array: `[N, byte0, byte1, ..., byte_{N-1}]`.

### Step 2: Huffman Decode Tables B and C

Each table (B and C) contains an embedded Huffman tree followed by a bitstream.

**Parse Huffman leaves:**
1. Read 4-byte **LE32** count of leaves
2. For each leaf (8 bytes per leaf):
   - Byte at offset +0 → symbol (uint8)
   - Bytes at offset +4..+7 → weight as **LE32 IEEE 754 float**
3. Read 4-byte **LE32** trailing value = bit budget (max bits to decode)
4. Remaining bytes = Huffman bitstream

**Build Huffman tree** (priority-queue merge):
1. Create leaf nodes with their float weights
2. Repeatedly extract the two lowest-weight nodes, create a parent with weight = sum of children
3. Root = last remaining node

**Decode bitstream:**
- Read bits **LSB-first** from each byte (bit 0 first, bit 7 last)
- Traverse tree: bit 0 → left child, bit 1 → right child
- On reaching a leaf: emit the leaf's symbol byte, reset to root
- Stop after consuming `bit_budget` bits

### Step 3: Interleave

Interleave decoded streams B and C back into the integer array. Process B values sequentially:

```
DEPTH = 8

while remaining > 0:
    bVal = decodedB[idxB]
    if bVal < N + DEPTH:
        push decodedC[idxC] to intArr;  idxC++
        push bVal to intArr
        remaining -= 2
    else:
        push bVal to intArr
        remaining -= 1
    idxB++
```

`remaining` starts at `len(decodedB) + len(decodedC)`.

### Step 4: Expand (RLE)

The integer array encodes a codebook followed by RLE-compressed pixel data.

1. First value = `literalCount` (codebook size)
2. Next `literalCount` values = codebook entries
3. Remaining values are processed as:
   - If value `w < literalCount + DEPTH`: **RLE run** — repeat count = `2^w`, next value is codebook index `(nextVal - DEPTH)` → emit `codebook[idx]` that many times
   - If value `w >= literalCount + DEPTH`: **single pixel** — emit `codebook[(w - literalCount) - DEPTH]`

### Step 5: Output

Copy expanded bytes to a `width × height` pixel buffer. Some files may produce slightly fewer pixels than expected (<1% shortfall is tolerable; zero-fill the remainder).

---

## 3. Subtype 0x0300 — Wavelet Codec

### 3.1 Payload Layout

Starting at offset 14 (after the common header):

```
[4 bytes]  BE32       — total compressed payload length
[payload_length bytes] — wavelet-compressed data
```

The payload begins with 3 header bytes:
1. **version** (byte) — controls extra-bits reading (0 = read extra bits, non-zero = skip)
2. **numLevels** (byte) — wavelet decomposition levels (3 or 4)
3. **filterType** (byte) — wavelet filter selection (0 or 1)

### 3.2 Wavelet Filters

Two filter types are supported. All filters are symmetric.

#### Filter Type 0 — CDF 9/7 (not used in known corpus)

Analysis low (9 taps): stored as IEEE 754 hex values:
```
[0x3d5889c7, 0xbd08e1cf, 0xbdbe9b19, 0x3ec6212d, 0x3f499a81,
 0x3ec6212d, 0xbdbe9b19, 0xbd08e1cf, 0x3d5889c7]
```

Analysis high (7 taps):
```
[0xbdb1a91a, 0xbd609caf, 0x3ee16f3a, 0x3f511889,
 0x3ee16f3a, 0xbd609caf, 0xbdb1a91a]
```

#### Filter Type 1 — 7/5 biorthogonal (100% of known corpus)

Analysis low (7 taps), **raw** values (before √2 scaling):
```
[0xbc2f8af9, 0xbd5b6db7, 0x3e857c58, 0x3f1b6db7,
 0x3e857c58, 0xbd5b6db7, 0xbc2f8af9]
```

Analysis high (5 taps), **raw** values:
```
[0xbd4ccccd, 0x3e800000, 0x3f19999a, 0x3e800000, 0xbd4ccccd]
```

For filter type 1 only: **multiply ALL coefficient values by `√2`** after loading.

#### Filter Derivation

Four filters are constructed:
- **h0** = analysis low (parity=0)
- **h1** = analysis high (parity=0)
- **g0** = synthesis low (parity=-1) — derived from h1
- **g1** = synthesis high (parity=1) — derived from h0

Synthesis filters are derived via **mirror sign alternation** (`deriveMirror`):

```
function deriveMirror(coeffs, center):
    result = copy of coeffs
    // First loop: center down to 0, alternating signs starting at +1
    sign = +1
    for i = center down to 0:
        result[i] = coeffs[i] * sign
        sign = -sign

    // Second loop: center+1 up to end, starting at sign = -1
    sign = -1
    for i = center+1 to length-1:
        result[i] = coeffs[i] * sign
        sign = -sign

    return result
```

**Center index** = `floor(length / 2)`.

For filter type 1: the √2 scaling is applied to h0 and h1 FIRST, then g0 and g1 are derived from the already-scaled values. Since deriveMirror is linear (sign flipping), this is equivalent to scaling all four filters by √2.

**Reconstruction uses: h1 (analysis high, parity=0) and g1 (synthesis high, parity=1).**

#### Filter Structure

Each filter has:
- `coeffs[]` — coefficient array
- `length` — number of taps
- `center` — center index = `floor(length / 2)`
- `parity` — parity parameter (0, -1, or 1)

### 3.3 Wavelet Pyramid

The image is decomposed into a multi-level pyramid. At each level, the dimensions are split:

```
function splitEvenOdd(n):
    if n is even:  return (n/2, n/2)
    if n is odd:   return ((n+1)/2, (n-1)/2)
```

Each level has 4 subbands:
- **LL** (low-low): `evenW × evenH`
- **LH** (low-high): `evenW × oddH`
- **HL** (high-low): `oddW × evenH`
- **HH** (high-high): `oddW × oddH`

The next level's input dimensions are `(evenW, evenH)` (the LL subband size).

**HH at level 0 is always zeroed** (not encoded in the bitstream).

### 3.4 Band Decoding

After the 3-byte header, the bitstream contains:

1. **Orientation flags** — 1 bit per detail subband (LSB-first bitstream), `detailSubbands` bits total
   - For 4 levels: 11 detail bands; for 3 levels: 8 detail bands
   - 0 = horizontal blocks, 1 = vertical blocks

2. **Per-band parameters** — for each detail subband (3 × BE16):
   - `bandQuantSteps` (unsigned 16-bit)
   - `bandScale` (signed 16-bit, divided by 32.0 → float, i.e. Q15-ish)
   - `bandOffset` (signed 16-bit, divided by 32.0 → float)

3. **Min/Max values** — 2 × BE16: `minVal`, `maxVal`

4. **Detail subband data** — 11 (or 8) subbands decoded sequentially

The detail subbands map to the pyramid as follows:

| View index | Level | Band | Our subband index | Quant (4 levels) |
|------------|-------|------|-------------------|------------------|
| 0 | 0 | HL | subbands[2] | 8 |
| 1 | 0 | LH | subbands[1] | 8 |
| 2 | 1 | HL | subbands[2] | 4 |
| 3 | 1 | LH | subbands[1] | 4 |
| 4 | 1 | HH | subbands[3] | 4 |
| 5 | 2 | HL | subbands[2] | 2 |
| 6 | 2 | LH | subbands[1] | 2 |
| 7 | 2 | HH | subbands[3] | 2 |
| 8 | 3 | HL | subbands[2] | 1 |
| 9 | 3 | LH | subbands[1] | 1 |
| 10 | 3 | HH | subbands[3] | 1 |

Quant steps per band: `[8, 8, 4, 4, 4, 2, 2, 2, 1, 1, 1]`

#### Band Size Calculation

```
if orientation == 0:
    bandSize = ceil(width / (quant * 2)) * height * 2
else:
    bandSize = ceil(height / (quant * 2)) * width * 2
```

#### copyStreamData (compressed sub-streams)

Each sub-stream within a band is stored as:
1. **BE16** compressed length
2. **zlib-compressed** data of that length

Decompress (inflate) into a buffer of the expected uncompressed size. Zero-pad if the decompressed output is shorter.

#### Decoding a Band (quant ≥ 2 path — Fischer coding)

For each band, three sub-streams are read:

**Stream 1: Magnitudes** — `bandSize` bytes (one byte per block)
- Each byte is the magnitude value
- If `version == 0` and the byte has bit 7 set (`& 0x80`): read 4 extra bits from an embedded bitstream
- Mask off bit 7 after reading: `magnitude = byte & 0x7F`

**Extra bits bitstream** (version 0 only):
- Initialized at the cursor position after magnitudes
- For each magnitude with bit 7 set: read 4 bits (LSB-first)
- After reading all extra bits: advance cursor by `ceil(bits_consumed / 8)` bytes

**Stream 2: Codewords** — zlib-compressed bitstream
- Buffer size = `5 × bandSize` bytes
- For each block: read `rankTable[quant][magnitude]` bits (LSB-first) → codeword value

**Coefficient reconstruction:**

```
fVar8 = float32(float32(bandScale / bandQuantSteps) * bandOffset)

for each block pair:
    sf = float32(levelScaleFactor(extraBits[i]))
    ratio = float32(fVar8 / sf)
    decoded[] = fischerDecode(quant, codeword, magnitude, diffTable)
    for k = 0 to quant-1:
        coefficientValue = float32(decoded[k] * ratio)
```

Where `levelScaleFactor(e) = (16.0 - e) / 16.0`.

**Block placement** — blocks are written in interleaved pairs:

For **orientation 0** (horizontal):
- Outer loop: `bx` from 0 to width, step `quant * 2`
- Inner loop: `by` from 0 to height, step 1
- Block 1: write quant values at (bx, by), (bx+2, by), (bx+4, by), ...
- Block 2: write quant values at (bx+1, by), (bx+3, by), (bx+5, by), ...

For **orientation 1** (vertical):
- Outer loop: `by` from 0 to height, step `quant * 2`
- Inner loop: `bx` from 0 to width, step 1
- Block 1: write quant values at (bx, by), (bx, by+2), (bx, by+4), ...
- Block 2: write quant values at (bx, by+1), (bx, by+3), (bx, by+5), ...

#### Decoding a Band (quant < 2 — direct coding)

- Buffer size = `5 × bandSize` bytes, zlib-compressed
- Bits per position = `ceil(ceil(log2(bandQuantSteps * 2 + 1)) * 0.125) * 8`
- Read each codeword, then: `value = (codeword % (bandQuantSteps*2+1) - bandQuantSteps) * (bandScale / bandQuantSteps) * bandOffset`
- Write pixels column-major: outer loop X, inner loop Y

### 3.5 Fischer Combinatorial Coding

Fischer decode is a **combinatorial unranking** algorithm. Given:
- `outLen` — number of output values (= quant, typically 1/2/4/8)
- `codeword` — the rank (integer read from bitstream)
- `magnitudeSum` — total absolute value sum
- `diffTable[q][m]` — exact count of signed q-tuples with sum of absolute values exactly m

It produces a signed integer tuple `out[0..outLen-1]` where `sum(|out[i]|) = magnitudeSum`.

**Algorithm:**

```
function fischerDecode(outLen, codeword, magnitudeSum, diffTable):
    out = array of outLen zeros
    if magnitudeSum == 0: return out

    remaining = magnitudeSum
    runningTotal = 0
    outIdx = 0
    remainingPositions = outLen

    while outIdx < outLen:
        if codeword == runningTotal:
            out[outIdx] = 0
            break

        zeroCount = diffTable[remainingPositions - 1][remaining]

        if codeword < zeroCount + runningTotal:
            out[outIdx] = 0
        else:
            iVar4 = runningTotal + zeroCount
            absVal = 1

            // Find the absolute value
            while true:
                subCount = diffTable[remainingPositions - 1][remaining - absVal]
                if codeword < iVar4 + subCount * 2: break
                iVar4 += subCount * 2
                absVal++

            // Determine sign
            subCount = diffTable[remainingPositions - 1][remaining - absVal]
            if codeword >= iVar4 AND codeword < subCount + iVar4:
                out[outIdx] = +absVal       // positive
            if subCount + iVar4 <= codeword:
                out[outIdx] = -absVal       // negative
                runningTotal = iVar4 + subCount
            else:
                runningTotal = iVar4

            remaining -= absVal

        remainingPositions--
        outIdx++

    // End fixup: dump leftover magnitude into last position
    if remaining > 0:
        lastVal = (outIdx < outLen) ? out[outIdx] : 0
        out[outLen - 1] = remaining - abs(lastVal)

    return out
```

**Diff table construction:**

`T(q, m)` = number of signed integer q-tuples with `sum(|xi|) = m` exactly.

Formula: `T(q, 0) = 1`, and for `m ≥ 1`:
```
T(q, m) = Σ_{j=1}^{min(q,m)} C(q,j) × C(m-1, j-1) × 2^j
```

The cumulative count `cumT(q, m) = Σ_{k=0}^{m} T(q, k)`.

The diff table is: `diff[q][m] = cumT(q, m) - cumT(q, m-1) = T(q, m)`.

Table dimensions:
- Rows 0–4: up to 201 columns
- Rows 5–8: up to 31 columns

### 3.6 LL Band

After all detail subbands are decoded, the LL (approximation) band of the deepest level is read:

**Reading:** Raw bytes, read in **column-major** order (outer loop = X, inner loop = Y). Each byte is stored as a float.

**Post-processing:**

```
range = maxVal - minVal           // both from the per-frame min/max
center = float32((range + minVal) * 0.5)
llScaleRaw = float32((minVal - range) * 0.5)
llScale = double(llScaleRaw) * (1.0 / 127.0)

for each pixel value p in LL band:
    val = (p - 127.0) * llScale + center
    val = clamp(val, min(minVal, range), max(minVal, range))
    store val back as float
```

### 3.7 Wavelet Reconstruction

Reconstruct from the deepest level upward. At each level, the output replaces the LL subband of the parent level.

**Per-level reconstruction:**

Two filters are used:
- **filter1** = h1 (analysis high, parity=0) → **SET** (overwrite) mode
- **filter2** = g1 (synthesis high, parity=1) → **ADD** (accumulate) mode

**Step 1: Vertical pass** (process column by column)

```
for each column x:
    tmpEven[x] = polyphase(filter1, SET, LL_column[x])
                + polyphase(filter2, ADD, LH_column[x])

    tmpOdd[x]  = polyphase(filter1, SET, HL_column[x])
                + polyphase(filter2, ADD, HH_column[x])
```

**Step 2: Horizontal pass** (process row by row)

```
for each row y:
    output[y] = polyphase(filter1, SET, tmpEven_row[y])
              + polyphase(filter2, ADD, tmpOdd_row[y])
```

**Edge extension parameters:**

| Dimension parity | filter1 (SET) params | filter2 (ADD) params |
|-----------------|---------------------|---------------------|
| Even | param4=1, param5=2 | param4=2, param5=1 |
| Odd  | param4=1, param5=1 | param4=2, param5=2 |

#### Polyphase Convolution

For output sample `i`, filter with center `c` and parity offset `p = -filter.parity`:

```
out[i] = Σ_{j=-c}^{c} coeffs[c - j] × src_extended[(i + p + j) / 2]
         (only summing terms where (i + p + j) is even)
```

**Edge extension boundaries:**
```
leftBound  = (param4 == 1) ? 0 : -1
rightBound = (param5 == 1) ? srcLen*2 - 2 : srcLen*2 - 1
```

**Edge extension function:** For out-of-bounds index `k`:
```
src_extended[k] = src[boundary - k]
```

The convolution has three sections:
1. **Slow start** (i = 0 to `center + parity - 1`): use `leftBound` for ALL out-of-bounds samples
2. **Fast interior** (pairs of outputs, no edge extension needed)
3. **Slow end** (remaining outputs): use `rightBound` for ALL out-of-bounds samples

### 3.8 Output Conversion

After reconstruction produces a float matrix at full image resolution:

```
for each pixel (x, y):
    val = matrix[y * width + x]
    if val <= 0: byte = 0
    else if val > 255: byte = 255
    else: byte = truncate_toward_zero(val)   // NOT round!
```

The output is 8-bit grayscale, one byte per pixel, stored row-major.

---

## 4. Constants Reference

| Value | Type | Usage |
|-------|------|-------|
| 0.5 | double | Center and scale calculations |
| 1.0/127.0 | double | LL band scale factor |
| 127.0 | double | LL band pixel offset |
| 32.0 | float | Q15 divisor for bandScale/bandOffset |
| 16.0 | double | levelScaleFactor base |
| 1.0/16.0 | double | levelScaleFactor multiplier |
| 0.125 | float | Bits-to-bytes conversion (1/8) |
| 0x80 | int | Extra bits flag mask |
| 5 | int | Codeword buffer size multiplier |
| 255.0 | float | Output pixel clamp maximum |
| 2.0 | double | Band size doubling / √2 source |
| 8 | int | Interleave depth (0x0400 codec) |

---

## 5. Rank Table (Hardcoded)

These are the bit lengths for codeword reading, indexed by `[quant][magnitude]`.

### quant = 2 (201 entries)

```
 0, 2, 3, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7,
 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 8, 8, 8, 8, 8, 8, 8,
 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
 8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
 9, 9, 9, 9, 9, 9, 9, 9, 9,10,10,10,10,10,10,10,10,10,10,10,
10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,
10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,
10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,10,
 0
```

### quant = 4 (201 entries)

```
 0, 3, 5, 7, 8, 9,10,10,11,11,12,12,13,13,13,14,14,14,14,15,
15,15,15,15,16,16,16,16,16,16,17,17,17,17,17,17,17,18,18,18,
18,18,18,18,18,18,18,19,19,19,19,19,19,19,19,19,19,19,19,20,
20,20,20,20,20,20,20,20,20,20,20,20,20,20,21,21,21,21,21,21,
21,21,21,21,21,21,21,21,21,21,21,21,21,22,22,22,22,22,22,22,
22,22,22,22,22,22,22,22,22,22,22,22,22,22,22,22,22,23,23,23,
23,23,23,23,23,23,23,23,23,23,23,23,23,23,23,23,23,23,23,23,
23,23,23,23,23,23,23,24,24,24,24,24,24,24,24,24,24,24,24,24,
24,24,24,24,24,24,24,24,24,24,24,24,24,24,24,24,24,24,24,24,
24,24,24,24,24,25,25,25,25,25,25,25,25,25,25,25,25,25,25,25,
 0
```

### quant = 8 (31 entries)

```
 0, 4, 7,10,12,14,15,17,18,19,20,21,22,22,23,24,
24,25,26,26,27,27,27,28,28,29,29,30,30,30, 0
```

For quant values not in {2, 4, 8}: all entries are 0 (these quant values are not used in practice).

---

## Bitstream Reading Convention

All bitstreams in the ITW format are read **LSB-first**:
- The first bit read from a byte is bit 0 (lowest bit)
- The last bit read is bit 7 (highest bit)
- When reading multi-bit values, the first bit read becomes bit 0 of the result

```
function readBits(n):
    value = 0
    mask = 1
    for i = 0 to n-1:
        bit = currentByte & 1
        currentByte >>= 1
        bitIndex++
        if bitIndex == 8:
            bitIndex = 0
            advance to next byte
        if bit: value |= mask
        mask <<= 1
    return value
```

---

## Float32 Precision

The original TIS.exe uses x87 FPU instructions with float32 (single precision) storage for most intermediate wavelet computations. For bit-exact matching, intermediate results in the coefficient reconstruction should be truncated to float32 at each step:

```
fVar8 = float32(float32(bandScale / bandValue) * bandOffset)
ratio = float32(fVar8 / float32(levelScaleFactor(extraBits)))
value = float32(decoded * ratio)
```

The LL band scaling uses double precision for the scale factor multiplication but float32 for storage:
```
llScaleRaw = float32((minVal - range) * 0.5)
llScale = double(llScaleRaw) * double(1.0/127.0)
```

Float-to-integer conversion uses **truncation toward zero** (not rounding), matching MSVC's `ftol` behavior.
