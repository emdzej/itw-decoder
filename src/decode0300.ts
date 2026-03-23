import { inflateSync } from "zlib";
import { DecodeResult, ITWError, readBE16, readBE32From2BE16 } from "./itw";

// ─── Global constants (from Ghidra data section) ────────────────────────────
const DAT_004ed190 = 0.5;       // double: center = (range + min) * 0.5
const DAT_004ed198 = 1.0 / 127; // double: LL band scale (0x3f80204081020408 = 1/127)
const DAT_004ed1a0 = 127.0;     // double: LL band offset (subtract from byte)
const DAT_004ed1f0 = 32.0;      // float:  Q15-ish divisor (0x42000000 = 32.0)
const DAT_004ed1d0 = 16.0;      // double: level_scale_factor base
const DAT_004ed1d8 = 1.0 / 16;  // double: level_scale_factor multiplier
const DAT_004ed130 = 0.125;     // float:  bits-to-bytes (1/8)
const DAT_004ed118 = 0x80;      // int:    extra bits flag mask
const DAT_004ed11c = 5;         // int:    buffer size multiplier

// ─── Cursor: tracks read position into the payload ─────────────────────────
class Cursor {
  pos: number;
  constructor(private buf: Uint8Array, offset: number) { this.pos = offset; }
  readByte(): number {
    if (this.pos >= this.buf.length) throw new ITWError("cursor overrun");
    return this.buf[this.pos++];
  }
  readBE16(): number {
    const v = readBE16(this.buf, this.pos);
    this.pos += 2;
    return v;
  }
  readBE32(): number {
    const v = readBE32From2BE16(this.buf, this.pos);
    this.pos += 4;
    return v;
  }
  /** Return a subarray from current position onward */
  remaining(): Uint8Array { return this.buf.subarray(this.pos); }
  /** zlib inflate: reads BE16 compressed length, then inflates into destSize buffer (zero-padded) */
  copyStreamData(destSize: number): Uint8Array {
    const compLen = this.readBE16();
    const compressed = this.buf.subarray(this.pos, this.pos + compLen);
    this.pos += compLen;
    const inflated = inflateSync(compressed, { maxOutputLength: destSize });
    // Zero-pad to destSize (matching C's calloc behavior)
    const result = new Uint8Array(destSize);
    result.set(new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength));
    return result;
  }
}

// ─── Bitstream reader (LSB-first, matching Ghidra's read_bits @ 004bc220) ───
// The C code reads bits from the LOW bit of each byte first, and accumulates
// the multi-bit result with the first-read bit as bit 0 (LSB).
class Bitstream {
  private data: Uint8Array;
  private byteIdx: number = 0;
  private bitIdx: number = 0;   // 0..7 within current byte
  private curByte: number = 0;
  constructor(data: Uint8Array) {
    this.data = data;
    // Match C: first byte is loaded on first read_bit call (when bitIdx==0)
  }
  /** Read a single bit (LSB-first from each byte) */
  private readBit(): number {
    if (this.bitIdx === 0) {
      this.curByte = this.byteIdx < this.data.length ? this.data[this.byteIdx] : 0;
    }
    const bit = this.curByte & 1;
    this.curByte >>= 1;
    this.bitIdx++;
    if (this.bitIdx === 8) {
      this.bitIdx = 0;
      this.byteIdx++;
    }
    return bit;
  }
  /** Read n bits, LSB-first: first bit read → bit 0 of result */
  readBits(n: number): number {
    let val = 0;
    let mask = 1;
    for (let i = 0; i < n; i++) {
      if (this.readBit()) {
        val |= mask;
      }
      mask <<= 1;
    }
    return val;
  }
  /** Return current byte-aligned position (for cursor tracking).
   *  Matches C's bitstream_finish: if bitIdx==0 return byteIdx, else byteIdx+1 */
  get bytePos(): number {
    return this.bitIdx === 0 ? this.byteIdx : this.byteIdx + 1;
  }
}

// ─── Q15 ─────────────────────────────────────────────────────────────────
function q15ToFloat(v: number): number {
  // v is a signed 16-bit int
  const s = (v << 16) >> 16; // sign extend
  return s / DAT_004ed1f0;
}

// ─── Wavelet filter coefficients ────────────────────────────────────────────
// Convert IEEE754 hex to float
function hexToFloat(h: number): number {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setInt32(0, h);
  return new DataView(buf).getFloat32(0);
}

interface WaveletFilters {
  analysisLow: number[];   // param_2
  analysisHigh: number[];  // param_4 (before mirror → param_3)
  synthLow: number[];      // param_3 (derived from analysisHigh)
  synthHigh: number[];     // param_5 (derived from analysisLow)
}

// Filter type 0: CDF 9/7 biorthogonal
const ANALYSIS_LOW_97 = [
  0x3d5889c7, 0xbd08e1cf, 0xbdbe9b19, 0x3ec6212d,
  // center is implicit (the filter is symmetric, stored as half-filter)
  // Actually, from Ghidra the 8 taps plus implicit center:
  // local_24..local_4 = 8 coefficients, center is param_2[3] (center offset)
].map(hexToFloat);

// Actually, from Ghidra wavelet_init_filters, for filter type 0:
// Analysis lowpass (set on param_2): local_24 array (8 elements, 9-tap symmetric)
const FILTER0_ANALYSIS_LOW = [
  hexToFloat(0x3d5889c7),  // 0.052861...
  hexToFloat(0xbd08e1cf),  // -0.033477...
  hexToFloat(0xbdbe9b19),  // -0.093057...
  hexToFloat(0x3ec6212d),  // 0.386942...
  // center coefficient is implicit at index=4, but the filter has 9 taps
  // mirror is: [idx=8]=local_4, [7]=local_8, ... [1]=local_20, [0]=local_24
  // local_24=0x3d5889c7, local_20=0xbd08e1cf, local_1c=0xbdbe9b19, local_18=0x3ec6212d
  // [center], local_10=0x3ec6212d, local_c=0xbdbe9b19, local_8=0xbd08e1cf, local_4=0x3d5889c7
];

// The filter_set_coeffs copies the local array into the filter's coeff array.
// For a 9-tap filter with center at index 4:
const F0_AL = [
  hexToFloat(0x3d5889c7),
  hexToFloat(0xbd08e1cf),
  hexToFloat(0xbdbe9b19),
  hexToFloat(0x3ec6212d),
  NaN, // center — needs to be computed as (1 - 2*(sum_of_above))
  hexToFloat(0x3ec6212d),
  hexToFloat(0xbdbe9b19),
  hexToFloat(0xbd08e1cf),
  hexToFloat(0x3d5889c7),
];

// Actually, rethinking: The filter has exactly 8 coefficients stored in local_24..local_4,
// The filter length is 9 (for low) and 7 (for high) based on wavelet_read_filter_type.
// But 8 values were stored. The 9th is the center which must be computed.
// Wait - let's look again. local_24 through local_4 = 8 dwords = 8 coefficients.
// But the filter length from wavelet_read_filter_type for type 0 is: low=9, high=7.
// So 8 stored + center (computed from normalization) = 9 total.

// Actually, looking more carefully: these 8 values are the full 8-tap non-center
// coefficients of the 9-tap filter. The center is derived.
// For CDF 9/7: known coefficients...

// Let me just use the known CDF 9/7 values instead:
// CDF 9/7 analysis lowpass (9 taps):
//   0.026749, -0.016864, -0.078223, 0.266864, 0.602949, 0.266864, -0.078223, -0.016864, 0.026749
// But wait, the hex values give us slightly different numbers. Let me just use the hex-derived values.

// Recomputing from hex:
// 0x3d5889c7 = 0.05286135
// 0xbd08e1cf = -0.03347732
// 0xbdbe9b19 = -0.09305732
// 0x3ec6212d = 0.38694268
// These are the 4 non-center coefficients on one side (symmetric).
// The center must make the sum = 1 (for lowpass):
// sum_sides = 2 * (0.05286135 - 0.03347732 - 0.09305732 + 0.38694268) = 2 * 0.31326939 = 0.62653878
// center = 1 - 0.62653878 = 0.37346122
// Hmm, but this doesn't match standard CDF 9/7. Let me just trust the data.

// Actually, looking at the filter structure more carefully:
// filter_alloc(NULL, length, parity) where parity affects the center index.
// For type 0: AL length=9 parity=0, AH length=7 parity=0, SL length=7 parity=-1, SH length=9 parity=1
// The filter's center index = floor(length/2) + parity_offset
// For length 9, parity 0: center = 4 (0-indexed)
// filter_set_coeffs copies from the local array into filter[4..4+center] etc.

// Actually I realize: the 8 stored values in local_24..local_4 are ALL 8 non-center taps.
// The center coefficient is stored at local_14 = 0x3f499a81.
// Wait no, local_14 is used for filter type 1 (the 7/5 case).

// Let me re-read the decompiled code more carefully. filter_set_coeffs takes the address
// of local_24 (for type 0 low) or local_5c (for type 0 high).
// For the lowpass, local_24..local_4 = 8 values.
// But length = 9. So there must be a 9th value somewhere.
// Looking at the local variables: local_14 = 0x3f499a81
// But local_14 is between the filter arrays... Actually local_24 through local_4
// are at offsets 0x24, 0x20, 0x1c, 0x18, 0x14, 0x10, 0x0c, 0x08, 0x04
// Wait - that's 9 values! local_24 = index0, local_20 = index1, ..., local_04 = index8
// But in the decompilation only 8 are assigned:
//   local_24, local_20, local_1c, local_18, (missing local_14), local_10, local_c, local_8, local_4
// local_14 = 0x3f499a81 is assigned! It's the center coefficient!

// So the 9 coefficients of analysis lowpass (type 0) are:
// local_24=0x3d5889c7, local_20=0xbd08e1cf, local_1c=0xbdbe9b19, local_18=0x3ec6212d,
// local_14=0x3f499a81, local_10=0x3ec6212d, local_c=0xbdbe9b19, local_8=0xbd08e1cf, local_4=0x3d5889c7

// Wait, let's check: is local_14 used for type 0 or type 1?
// In the decompiled code:
//   local_14 = 0x3f499a81;  (assigned unconditionally at top of function)
//   For type 0: filter_set_coeffs(&local_24, param_2) → copies starting from local_24
//   For type 1: filter_set_coeffs(&local_40, param_2), filter_set_coeffs(&local_70, param_4)
// 
// local_24 through local_4 means bytes at [ebp-0x24] through [ebp-0x4].
// The contiguous block from [ebp-0x24] to [ebp-0x04] is 0x24-0x04=0x20=32 bytes, 
// but with 4-byte alignment: [ebp-0x24], [ebp-0x20], [ebp-0x1c], [ebp-0x18],
//   [ebp-0x14], [ebp-0x10], [ebp-0x0c], [ebp-0x08], [ebp-0x04] = 9 float values!
// So local_14 IS the center coefficient of the analysis lowpass filter!

// OK but local_14 was also assigned differently in type 1 section...
// Looking at assignments: local_14 = 0x3f499a81 is set at the top (for type 0 center)
// But local_50 = 0x3f511889 is also set. Let me check what local_50 is.

// For analysis high (type 0): local_5c..local_44
// local_5c=0xbdb1a91a, local_58=0xbd609caf, local_54=0x3ee16f3a, local_50=0x3f511889
// local_4c=0x3ee16f3a, local_48=0xbd609caf, local_44=0xbdb1a91a
// That's 7 values at local_5c through local_44. Perfect for the 7-tap high filter.
// But wait: local_5c, local_58, local_54, local_50, local_4c, local_48, local_44 = 7 values.

// So: analysis lowpass = 9 taps: local_24(0x3d5889c7), local_20(0xbd08e1cf), local_1c(0xbdbe9b19),
//     local_18(0x3ec6212d), local_14(0x3f499a81), local_10(0x3ec6212d), local_c(0xbdbe9b19),
//     local_8(0xbd08e1cf), local_4(0x3d5889c7)
//     Analysis highpass = 7 taps: local_5c(0xbdb1a91a), local_58(0xbd609caf), local_54(0x3ee16f3a),
//     local_50(0x3f511889), local_4c(0x3ee16f3a), local_48(0xbd609caf), local_44(0xbdb1a91a)

// For filter type 1 (7/5 biorthogonal):
// Analysis lowpass = 7 taps: local_40..local_28
// local_40=0xbc2f8af9, local_3c=0xbd5b6db7, local_38=0x3e857c58, local_34=0x3f1b6db7,
// local_30=0x3e857c58, local_2c=0xbd5b6db7, local_28=0xbc2f8af9
// Analysis highpass = 5 taps: local_70..local_60
// local_70=0xbd4ccccd, local_6c=0x3e800000, local_68=0x3f19999a,
// local_64=0x3e800000, local_60=0xbd4ccccd

function buildFilterCoeffs(filterType: number): {
  analysisLowCoeffs: number[], analysisHighCoeffs: number[],
  analysisLowLen: number, analysisHighLen: number
} {
  if (filterType === 0) {
    // CDF 9/7
    return {
      analysisLowLen: 9,
      analysisLowCoeffs: [
        hexToFloat(0x3d5889c7), hexToFloat(0xbd08e1cf), hexToFloat(0xbdbe9b19),
        hexToFloat(0x3ec6212d), hexToFloat(0x3f499a81), hexToFloat(0x3ec6212d),
        hexToFloat(0xbdbe9b19), hexToFloat(0xbd08e1cf), hexToFloat(0x3d5889c7),
      ],
      analysisHighLen: 7,
      analysisHighCoeffs: [
        hexToFloat(0xbdb1a91a), hexToFloat(0xbd609caf), hexToFloat(0x3ee16f3a),
        hexToFloat(0x3f511889), hexToFloat(0x3ee16f3a), hexToFloat(0xbd609caf),
        hexToFloat(0xbdb1a91a),
      ],
    };
  } else if (filterType === 1) {
    // 7/5 biorthogonal, scaled by sqrt(2)
    const s = Math.sqrt(2.0);
    return {
      analysisLowLen: 7,
      analysisLowCoeffs: [
        hexToFloat(0xbc2f8af9) * s, hexToFloat(0xbd5b6db7) * s, hexToFloat(0x3e857c58) * s,
        hexToFloat(0x3f1b6db7) * s, hexToFloat(0x3e857c58) * s, hexToFloat(0xbd5b6db7) * s,
        hexToFloat(0xbc2f8af9) * s,
      ],
      analysisHighLen: 5,
      analysisHighCoeffs: [
        hexToFloat(0xbd4ccccd) * s, hexToFloat(0x3e800000) * s, hexToFloat(0x3f19999a) * s,
        hexToFloat(0x3e800000) * s, hexToFloat(0xbd4ccccd) * s,
      ],
    };
  } else {
    throw new ITWError(`unsupported filter type ${filterType}`);
  }
}

// Derive mirror filter (for synthesis from analysis):
// filter_derive_mirror(center, src, dest):
//   First loop: from center down to 0, sign starts at +1 and alternates
//   Second loop: from center+1 up to len-1, sign restarts at +1 and alternates
//   dest[i] = src[i] * sign  (NO reversal — same index for src and dest)
//
// Sign pattern for 9-tap (center=4): [+1,-1,+1,-1,+1, +1,-1,+1,-1]
// Sign pattern for 7-tap (center=3): [-1,+1,-1,+1, +1,-1,+1]
function deriveMirror(coeffs: number[], center: number): number[] {
  const len = coeffs.length;
  const result = new Array(len);
  // First loop: center down to 0, sign alternates starting at +1
  let sign = 1;
  for (let i = center; i >= 0; i--) {
    result[i] = coeffs[i] * sign;
    sign = -sign;
  }
  // Second loop: center+1 up to len-1, sign restarts at +1
  sign = 1;
  for (let i = center + 1; i < len; i++) {
    result[i] = coeffs[i] * sign;
    sign = -sign;
  }
  return result;
}

interface Filter {
  coeffs: number[];
  length: number;
  center: number; // center index
  parity: number;
}

function makeFilter(coeffs: number[], length: number, parity: number): Filter {
  return { coeffs, length, center: Math.floor(length / 2), parity };
}

function initFilters(filterType: number): {
  reconstructFilter1: Filter, reconstructFilter2: Filter
} {
  const { analysisLowCoeffs, analysisHighCoeffs, analysisLowLen, analysisHighLen } = buildFilterCoeffs(filterType);
  
  // From Ghidra wavelet_init_filters:
  // param_2 = analysis low  (length = analysisLowLen, parity 0)
  // param_4 = analysis high (length = analysisHighLen, parity 0)
  // param_3 = synthesis low  (length = analysisHighLen, parity -1) — derived from analysis high
  // param_5 = synthesis high (length = analysisLowLen, parity 1) — derived from analysis low
  
  // filter_derive_mirror(center, src, dest):
  const analysisLowCenter = Math.floor(analysisLowLen / 2);
  const analysisHighCenter = Math.floor(analysisHighLen / 2);
  const synthHighCoeffs = deriveMirror(analysisLowCoeffs, analysisLowCenter);
  // synthLow not needed for reconstruction (but computed in the original for completeness)
  // const synthLowCoeffs = deriveMirror(analysisHighCoeffs, analysisHighCenter);
  
  // Reconstruction uses: puVar6 (analysis high) and puVar7 (synthesis high)
  // wavelet_reconstruct_all(puVar6, puVar7, pyramid, image)
  //   where puVar6 = filter_alloc(NULL, analysisHighLen, 0)  → analysis high
  //         puVar7 = filter_alloc(NULL, analysisLowLen, 1)   → synthesis high
  const analysisHigh = makeFilter(analysisHighCoeffs, analysisHighLen, 0);
  const synthHigh = makeFilter(synthHighCoeffs, analysisLowLen, 1);
  
  return { reconstructFilter1: analysisHigh, reconstructFilter2: synthHigh };
}

// ─── Fischer rank coding tables ─────────────────────────────────────────────
// Three tables are used:
//   1. BASE TABLE: cumT(q, m) = number of signed q-tuples with sum(|xi|) <= m
//      Computed mathematically. Used to build the diff table.
//   2. RANK TABLE: Hardcoded bit lengths from the binary. Used to determine
//      how many bits to read for each codeword from the bitstream.
//   3. DIFF TABLE: exact count T(q, m) = base[q][m] - base[q][m-1].
//      Passed to fischerDecode for combinatorial unranking.

const MAX_Q = 9;    // rows 0..8
const MAX_M_LARGE = 201; // columns for rows 0-4
const MAX_M_SMALL = 31;  // columns for rows 5-8

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < Math.min(k, n - k); i++) {
    result = result * (n - i) / (i + 1);
  }
  return Math.round(result);
}

/** Number of signed integer q-tuples with sum of absolute values exactly m */
function countExact(q: number, m: number): number {
  if (m === 0) return 1;
  let sum = 0;
  for (let j = 1; j <= Math.min(q, m); j++) {
    sum += binomial(q, j) * binomial(m - 1, j - 1) * (1 << j);
  }
  return sum;
}

/** Cumulative count: number of signed integer q-tuples with sum of abs values <= m */
function countCumulative(q: number, m: number): number {
  let total = 0;
  for (let k = 0; k <= m; k++) {
    total += countExact(q, k);
  }
  return total;
}

/**
 * Build the base table (9 × maxM). 
 * base_table[q][m] = cumT(q, m) = cumulative count of vectors.
 */
function buildBaseTable(): number[][] {
  const table: number[][] = [];
  for (let q = 0; q < MAX_Q; q++) {
    const maxM = q < 5 ? MAX_M_LARGE : MAX_M_SMALL;
    const row = new Array(maxM).fill(0);
    row[0] = 1;
    if (q === 0) {
      for (let m = 0; m < maxM; m++) row[m] = 1;
    } else {
      for (let m = 1; m < maxM; m++) {
        row[m] = countCumulative(q, m);
      }
    }
    table.push(row);
  }
  return table;
}

/**
 * Build the diff table from the base table.
 * diff[q][m] = base[q][m] - base[q][m-1] = T(q, m) = exact count for magnitude m.
 * diff[q][0] = 1 for all q; diff[0][m>=1] = 0.
 * This table is used by fischerDecode for combinatorial unranking.
 */
function buildDiffTable(baseTable: number[][]): number[][] {
  const table: number[][] = [];
  for (let q = 0; q < MAX_Q; q++) {
    const maxM = q < 5 ? MAX_M_LARGE : MAX_M_SMALL;
    const row = new Array(maxM).fill(0);
    row[0] = 1; // T(q, 0) = 1
    if (q === 0) {
      // Row 0: diff[0][0] = 1, diff[0][m>=1] = 0
    } else {
      for (let m = 1; m < maxM; m++) {
        row[m] = baseTable[q][m] - baseTable[q][m - 1];
      }
    }
    table.push(row);
  }
  return table;
}

// ─── Hardcoded rank table (bit lengths for codewords) ───────────────────────
// From Ghidra fischer_build_rank_table: 603 hardcoded values.
// Indexed as: rankTable[quant][magnitude] → number of bits for codeword.
// Only quant=2 (201 entries), quant=4 (201 entries), quant=8 (31 entries) are stored.

// prettier-ignore
const RANK_TABLE_Q2 = [
  0, 2, 3, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 8, 8, 8, 8, 8, 8, 8,
  8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
  8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
  9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
  9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9,
  9, 9, 9, 9, 9, 9, 9, 9, 9, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
  10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
  10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
  10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
  0,
];

// prettier-ignore
const RANK_TABLE_Q4 = [
  0, 3, 5, 7, 8, 9, 10, 10, 11, 11, 12, 12, 13, 13, 13, 14, 14, 14, 14, 15,
  15, 15, 15, 15, 16, 16, 16, 16, 16, 16, 17, 17, 17, 17, 17, 17, 17, 18, 18, 18,
  18, 18, 18, 18, 18, 18, 18, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 20,
  20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 21, 21, 21, 21, 21, 21,
  21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 22, 22, 22, 22, 22, 22, 22,
  22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 23, 23, 23,
  23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23,
  23, 23, 23, 23, 23, 23, 23, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
  24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
  24, 24, 24, 24, 24, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25,
  0,
];

// prettier-ignore
const RANK_TABLE_Q8 = [
  0, 4, 7, 10, 12, 14, 15, 17, 18, 19, 20, 21, 22, 22, 23, 24,
  24, 25, 26, 26, 27, 27, 27, 28, 28, 29, 29, 30, 30, 30, 0,
];

/**
 * Build the rank table structure from the hardcoded arrays.
 * Maps quant → magnitude → bit length.
 * For quant < 2 (quant=1): bit length is computed as ceil(log2(m*2+1)).
 * For quant not in {2,4,8}: returns 0 (shouldn't occur in practice).
 */
function buildRankTable(): number[][] {
  // We need rows for quant=0..8 to match the int_array(9, 0xC9, 1) structure.
  // The Ghidra code stores into: row=2 (quant=2), row=4 (quant=4), row=8 (quant=8).
  // All other rows are left at 0 (the table is zero-initialized by int_array_alloc).
  const table: number[][] = [];
  for (let q = 0; q < MAX_Q; q++) {
    const maxM = q < 5 ? MAX_M_LARGE : MAX_M_SMALL;
    const row = new Array(maxM).fill(0);
    if (q === 2) {
      for (let m = 0; m < maxM; m++) row[m] = RANK_TABLE_Q2[m];
    } else if (q === 4) {
      for (let m = 0; m < maxM; m++) row[m] = RANK_TABLE_Q4[m];
    } else if (q === 8) {
      for (let m = 0; m < Math.min(maxM, RANK_TABLE_Q8.length); m++) row[m] = RANK_TABLE_Q8[m];
    }
    table.push(row);
  }
  return table;
}

/**
 * Look up a value from a 2D table. Returns the value at table[q][m],
 * or 0 if out of bounds (matches C zero-initialized array behavior).
 */
function tableLookup(table: number[][], q: number, m: number): number {
  if (q < 0 || q >= table.length) return 0;
  const row = table[q];
  if (m < 0 || m >= row.length) return 0;
  return row[m];
}

// ─── Fischer decode ──────────────────────────────────────────────────────────
// Combinatorial unranking: given a codeword (rank), magnitude sum, and output length,
// decode the unique signed integer tuple.
// Uses the DIFF TABLE (exact counts T(q,m)) for lookups.
// T(q, m) = number of signed q-tuples with sum(|xi|) EXACTLY equal to m.
// The unranking partitions by first-position value:
//   T(n-1, m) tuples where pos[0]=0 (same total magnitude distributed among n-1 remaining positions)
//   T(n-1, m-a) tuples where |pos[0]|=a (for each sign), counted as 2*T(n-1, m-a)
// From Ghidra fischer_decode:
//   - uVar3 = outLen (*out_table)
//   - uVar5 starts at outLen, decremented each iteration
//   - calc_rank_bit_length(rank_table, uVar5-1, local_10, 0) looks up diffTable[remaining_positions-1][remaining_magnitude]
//   - local_10 = remaining magnitude, local_c = output index
function fischerDecode(
  outLen: number, codeword: number, magnitudeSum: number,
  diffTable: number[][]
): number[] {
  const out = new Array(outLen).fill(0);
  if (magnitudeSum === 0) return out;
  
  let remaining = magnitudeSum;  // local_10
  let runningTotal = 0;          // iVar4
  let outIdx = 0;                // local_c
  let remainingPositions = outLen; // uVar5

  while (outIdx < outLen) {
    if (codeword === runningTotal) {
      out[outIdx] = 0;
      break;
    }
    
    // Count of tuples with 0 at this position: T(n-1, m) = exact count of
    // (n-1)-tuples with sum of abs values exactly equal to remaining magnitude
    const zeroCount = tableLookup(diffTable, remainingPositions - 1, remaining);
    
    if (codeword < zeroCount + runningTotal) {
      // Zero at this position
      out[outIdx] = 0;
    } else {
      // Non-zero: find the absolute value
      let iVar4 = runningTotal + zeroCount;
      let absVal = 1; // local_8
      
      while (true) {
        const subCount = tableLookup(diffTable, remainingPositions - 1, remaining - absVal);
        if (codeword < iVar4 + subCount * 2) break;
        iVar4 += subCount * 2;
        absVal++;
        if (absVal > remaining + 1) {
          console.error(`fischerDecode INFINITE LOOP: outLen=${outLen} cw=${codeword} magSum=${magnitudeSum} remaining=${remaining} absVal=${absVal} iVar4=${iVar4} outIdx=${outIdx}`);
          throw new Error('fischerDecode infinite loop');
        }
      }
      
      // Determine sign: positive or negative
      const subCount = tableLookup(diffTable, remainingPositions - 1, remaining - absVal);
      if (codeword >= iVar4 && codeword < subCount + iVar4) {
        // Positive
        out[outIdx] = absVal;
      }
      // Check if negative
      if (subCount + iVar4 <= codeword) {
        out[outIdx] = -absVal;
        runningTotal = iVar4 + subCount;
      } else {
        runningTotal = iVar4;
      }
      
      remaining -= absVal;
    }
    
    remainingPositions--;
    outIdx++;
  }
  
  // End fixup: if remaining magnitude > 0, adjust the last position
  // From Ghidra: if (0 < local_10) { last = outLen-1; val = out[last]; out[last] = remaining - abs(val); }
  // Wait, the Ghidra code says:
  //   iVar4 = uVar3 - 1 (= outLen - 1)
  //   uVar3 = int_table_get(out_table, local_c)  [local_c = outIdx at loop end]
  //   int_table_set(out_table, local_10 - abs(uVar3), iVar4)
  // So: out[outLen-1] = remaining - abs(out[outIdx])
  // Hmm, that means it reads from outIdx (which is the last written position + 1 or loop-end)
  // and writes to outLen-1. Let me re-read...
  // After the loop: local_c was incremented past the last written position.
  // "uVar3 = int_table_get(out_table, local_c)" reads the NEXT position (which might be 0).
  // Actually no: the loop does: outIdx++ at end of each iteration, so after the break,
  // outIdx points to the position where we wrote 0 and broke. If we didn't break,
  // outIdx = outLen after the loop.
  // Hmm wait, looking at Ghidra more carefully:
  // The "if (codeword == iVar4) { set 0 at local_c; break; }" breaks BEFORE incrementing.
  // In the normal path, the loop body ends with: uVar5--; uVar2=get(out,local_c); local_c++; ...
  // So when breaking on codeword==runningTotal, local_c is the position where 0 was set.
  // 
  // The end fixup: "uVar3 = int_table_get(out_table, local_c)" — local_c is the last-written index
  // (from the break) or the current outIdx. Then out[outLen-1] = remaining - abs(out[local_c]).
  // 
  // Hmm, that's odd. Let me re-read the Ghidra code more carefully...
  // Actually in the non-break path: the last line of the loop is:
  //   uVar2 = int_table_get(out_table, local_c); local_c++; local_10 -= abs(uVar2);
  // So local_c is incremented AFTER reading. At loop end, local_c = outLen.
  // But the fixup reads from local_c which is outLen — that's out of bounds!
  // Unless... the fixup only triggers when remaining > 0 AND the break happened.
  // In the break case, local_c is the break position (not incremented).
  // Actually wait, looking at the Ghidra code structure:
  //   do {
  //     if (codeword == iVar4) { set(0, local_c); break; }
  //     ...process...
  //     uVar5--;
  //     uVar2 = get(out, local_c);
  //     local_c++;
  //     local_10 -= abs(uVar2);
  //   } while (local_c < outLen);
  //
  //   if (remaining > 0) {
  //     iVar4 = outLen - 1;
  //     uVar3 = get(out, local_c);
  //     set(out, remaining - abs(uVar3), iVar4);
  //   }
  //
  // When the break fires: local_c = break position. remaining was not updated.
  // The fixup then reads out[break_position] (which was just set to 0) → abs = 0
  // Then sets out[outLen-1] = remaining - 0 = remaining.
  // This makes sense! It dumps the leftover magnitude into the last position.
  
  if (remaining > 0) {
    const lastIdx = outLen - 1;
    // C code reads out[outIdx] which may be out of bounds (outIdx == outLen after full loop).
    // In C, the zero-initialized array has 0 beyond bounds. In JS, out[outLen] = undefined.
    const lastVal = outIdx < outLen ? out[outIdx] : 0;
    const absLast = Math.abs(lastVal);
    out[lastIdx] = remaining - absLast;
  }
  
  return out;
}

// ─── Wavelet pyramid ──────────────────────────────────────────────────────
interface Matrix {
  data: Float32Array;
  width: number;
  height: number;
}

function matrixCreate(w: number, h: number): Matrix {
  return { data: new Float32Array(w * h), width: w, height: h };
}

function matrixGet(m: Matrix, x: number, y: number): number {
  return m.data[y * m.width + x];
}

function matrixSet(m: Matrix, x: number, y: number, v: number): void {
  m.data[y * m.width + x] = v;
}

function splitEvenOdd(n: number): [number, number] {
  // From Ghidra split_even_odd: if n is even, both halves = n/2
  // If n is odd, even = (n+1)/2, odd = (n-1)/2
  if ((n & 1) === 0) {
    return [n / 2, n / 2];
  } else {
    return [(n + 1) / 2, (n - 1) / 2];
  }
}

interface Level {
  subbands: Matrix[]; // 0=LL, 1=LH, 2=HL, 3=HH (though HL at level 0 is zeroed)
}

interface Pyramid {
  levels: Level[];
  numLevels: number;
}

function pyramidCreate(width: number, height: number, numLevels: number): Pyramid {
  const levels: Level[] = [];
  let w = width, h = height;
  
  for (let lev = 0; lev < numLevels; lev++) {
    const [ew, ow] = splitEvenOdd(w);
    const [eh, oh] = splitEvenOdd(h);
    
    // Subbands: LL(ew×eh), LH(ew×oh), HL(ow×eh), HH(ow×oh)
    const ll = matrixCreate(ew, eh);
    const lh = matrixCreate(ew, oh);
    const hl = matrixCreate(ow, eh);
    const hh = matrixCreate(ow, oh);
    levels.push({ subbands: [ll, lh, hl, hh] });
    
    // Next level operates on LL
    w = ew;
    h = eh;
  }
  
  return { levels, numLevels };
}

// ─── Polyphase synthesis (from Ghidra polyphase_convolve @ 004bc940) ────────
// 
// The synthesis filter bank reconstructs the signal from subband samples.
// For a filter with center index `c`, parity offset `p = -filter_parity`,
// the convolution for output sample i is:
//
//   out[i] = Σ_{j=-c}^{c} coeffs[c - j] * src_extended[(i + c + p + j) / 2]
//            (only summing where (i + c + p + j) is even)
//
// Edge extension: src_extended[k] = src[boundary - k] for k outside [0, srcLen)
// where boundary depends on the extension type (param4, param5).

/**
 * Edge-extend a source sample. Matches Ghidra's edge_extend_sample.
 * @param src source array
 * @param idx requested index (may be negative or >= srcLen)
 * @param srcLen number of valid samples
 * @param boundary reflection boundary
 */
function edgeExtend(src: Float32Array, idx: number, srcLen: number, boundary: number): number {
  if (idx >= 0 && idx < srcLen) return src[idx];
  return src[boundary - idx];
}

/**
 * 1D polyphase synthesis convolution.
 * Matches Ghidra's polyphase_convolve @ 004bc940 / FUN_004bcdc0 (add variant).
 *
 * Three sections exactly as in the original:
 *   1. Slow start (0 to center-parity): edge extension with leftBound
 *   2. Fast interior: direct polyphase access (no edge extension needed)
 *   3. Slow end (remainder to dstLen): edge extension with rightBound
 *
 * CRITICAL: The slow-start uses leftBound for ALL out-of-bounds samples,
 * and slow-end uses rightBound for ALL out-of-bounds samples.
 * This differs from our previous per-tap boundary selection (k < 0 ? left : right)
 * which caused visual artifacts.
 */
function polyphaseConvolve1D(
  filter: Filter,
  dst: Float32Array, dstLen: number,
  src: Float32Array, srcLen: number,
  param4: number, param5: number,
  add: boolean  // false = set (overwrite), true = add (accumulate)
): void {
  const c = filter.center;      // filter[3] = (length-1)/2
  const p = -filter.parity;     // filter[5] = -parity from filter_alloc
  
  // Edge extension boundaries (from edge_extension_setup)
  const leftBound  = (param4 === 1) ? 0 : -1;
  const rightBound = (param5 === 1) ? srcLen * 2 - 2 : srcLen * 2 - 1;
  
  // Section boundaries (from Ghidra):
  // slowStartEnd = center + parity  (= center - (-parity) = center - p... wait, iVar5 = filter[5] = -parity)
  // In Ghidra: uVar8 = iVar4 - iVar5, where iVar4=center, iVar5=*(param_1+0x14)=filter[5]=-parity
  // BUT iVar5 is stored as: EAX = filter[5], NEG EAX → iVar5_stored = -filter[5] = parity
  // Wait — re-reading the ASM:
  //   MOV EAX,[EDI+0x14]  → EAX = filter[5] = -parity_param
  //   NEG EAX             → EAX = parity_param
  //   MOV [ESP+0x28],EAX  → stored_parity = parity_param
  // Then: uVar8 (slowStartEnd) = center + stored_parity... wait no:
  //   ADD EAX,ESI  → EAX = parity_param + center (at 004bc95b)
  //   This is stored at [ESP+0x1c] = center + parity_param
  // That's the slow-start end boundary.
  //
  // And fastEnd = dstLen - center - parity_param - 2
  //   (from: EAX = dstLen - center, SUB EAX, parity_param, SUB EAX, 2)
  //
  // With our variable names: p = -parity_param, so:
  //   slowStartEnd = center - p  (= center + parity_param)
  //   fastEnd = dstLen - center + p - 2  (= dstLen - center - parity_param - 2)
  
  const slowStartEnd = c - p;   // = center + parity_param
  const fastEnd = dstLen - c + p - 2; // = dstLen - center - parity_param - 2
  
  // ── Section 1: Slow start (i from 0 to slowStartEnd-1) ──
  // Uses leftBound for ALL out-of-bounds edge extension
  for (let i = 0; i < slowStartEnd && i < dstLen; i++) {
    let sum = 0;
    for (let j = -c; j <= c; j++) {
      const upIdx = i + p + j;
      if ((upIdx & 1) === 0) {
        const k = upIdx >> 1;
        const sample = edgeExtend(src, k, srcLen, leftBound);
        sum += sample * filter.coeffs[c - j];
      }
    }
    if (add) {
      dst[i] += sum;
    } else {
      dst[i] = sum;
    }
  }
  
  // ── Section 2: Fast interior (i from slowStartEnd to fastEnd-1, stepping by 2) ──
  // Processes two outputs per iteration using polyphase decomposition.
  // No edge extension needed — all source indices are guaranteed in-bounds.
  //
  // From Ghidra: pfVar10 = &coeffs[center * 2] (center of coeff array, float ptr)
  //   Even output (i): taps at coeffs[center], coeffs[center-2], coeffs[center-4], ...
  //     multiplied by src[srcIdx], src[srcIdx+1], src[srcIdx+2], ...
  //   Odd output (i+1): taps at coeffs[center-1], coeffs[center-3], coeffs[center-5], ...
  //     multiplied by src[srcIdx+1], src[srcIdx+2], src[srcIdx+3], ...
  //
  // The fast interior is functionally equivalent to the slow path for in-bounds samples,
  // just optimized with pointer arithmetic. We use the slow-path formula here since
  // it's clearer and produces identical results for in-bounds samples.
  {
    let i = slowStartEnd;
    while (i < fastEnd) {
      // Even output sample (i)
      let sum0 = 0;
      for (let j = -c; j <= c; j++) {
        const upIdx = i + p + j;
        if ((upIdx & 1) === 0) {
          const k = upIdx >> 1;
          // All k should be in-bounds in the fast section
          sum0 += src[k] * filter.coeffs[c - j];
        }
      }
      if (add) { dst[i] += sum0; } else { dst[i] = sum0; }
      
      // Odd output sample (i+1)
      let sum1 = 0;
      for (let j = -c; j <= c; j++) {
        const upIdx = (i + 1) + p + j;
        if ((upIdx & 1) === 0) {
          const k = upIdx >> 1;
          sum1 += src[k] * filter.coeffs[c - j];
        }
      }
      if (add) { dst[i + 1] += sum1; } else { dst[i + 1] = sum1; }
      
      i += 2;
    }
    
    // ── Section 3: Slow end (remaining samples from i to dstLen-1) ──
    // Uses rightBound for ALL out-of-bounds edge extension
    while (i < dstLen) {
      let sum = 0;
      for (let j = -c; j <= c; j++) {
        const upIdx = i + p + j;
        if ((upIdx & 1) === 0) {
          const k = upIdx >> 1;
          const sample = edgeExtend(src, k, srcLen, rightBound);
          sum += sample * filter.coeffs[c - j];
        }
      }
      if (add) {
        dst[i] += sum;
      } else {
        dst[i] = sum;
      }
      i++;
    }
  }
}

// ─── Wavelet reconstruction ────────────────────────────────────────────────
// From Ghidra wavelet_reconstruct_level @ 004bc640:
// param_1 = filter1 (analysis high, parity 0) → used in wavelet_filter_apply (SET)
// param_2 = filter2 (synthesis high, parity 1) → used in wavelet_filter_add (ADD)
//
// Vertical pass (direction=1, iterate over columns):
//   tmpEven = filter1 * LL + filter2 * LH   (column-by-column)
//   tmpOdd  = filter1 * HL + filter2 * HH   (column-by-column)
//
// Horizontal pass (direction=0, iterate over rows):
//   output = filter1 * tmpEven + filter2 * tmpOdd  (row-by-row)
//
// The param5/param6 arguments to wavelet_filter_apply/add control edge extension:
//   height even: apply(f1, dst, src, 1, 1, 2) then add(f2, dst, src, 1, 2, 1)
//   height odd:  apply(f1, dst, src, 1, 1, 1) then add(f2, dst, src, 1, 2, 2)
//   width even:  apply(f1, dst, src, 0, 1, 2) then add(f2, dst, src, 0, 2, 1)
//   width odd:   apply(f1, dst, src, 0, 1, 1) then add(f2, dst, src, 0, 2, 2)

function waveletReconstructLevel(
  filter1: Filter, filter2: Filter,
  output: Matrix, level: Level
): void {
  const outW = output.width;
  const outH = output.height;
  const [evenW, oddW] = splitEvenOdd(outW);
  const [evenH, oddH] = splitEvenOdd(outH);
  
  const ll = level.subbands[0]; // LL: evenW × evenH
  const lh = level.subbands[1]; // LH: evenW × oddH
  const hl = level.subbands[2]; // HL: oddW × evenH
  const hh = level.subbands[3]; // HH: oddW × oddH
  
  // Determine edge extension params based on parity
  const hEven = (outH & 1) === 0;
  const wEven = (outW & 1) === 0;
  const vLowP4  = 1, vLowP5  = hEven ? 2 : 1;
  const vHighP4 = 2, vHighP5 = hEven ? 1 : 2;
  const hLowP4  = 1, hLowP5  = wEven ? 2 : 1;
  const hHighP4 = 2, hHighP5 = wEven ? 1 : 2;
  
  // Temporary buffers for vertical pass results
  const tmpEven = matrixCreate(evenW, outH);
  const tmpOdd  = matrixCreate(oddW, outH);
  
   // ── Step 1: Vertical pass (column by column) ──
  // tmpEven columns: filter1 * LL_col + filter2 * LH_col
  for (let x = 0; x < evenW; x++) {
    const col = new Float32Array(outH);
    const llCol = new Float32Array(evenH);
    for (let y = 0; y < evenH; y++) llCol[y] = matrixGet(ll, x, y);
    polyphaseConvolve1D(filter1, col, outH, llCol, evenH, vLowP4, vLowP5, false);
    
    const lhCol = new Float32Array(oddH);
    for (let y = 0; y < oddH; y++) lhCol[y] = matrixGet(lh, x, y);
    polyphaseConvolve1D(filter2, col, outH, lhCol, oddH, vHighP4, vHighP5, true);
    
    for (let y = 0; y < outH; y++) tmpEven.data[y * evenW + x] = col[y];
  }
  
  // tmpOdd columns: filter1 * HL_col + filter2 * HH_col
  for (let x = 0; x < oddW; x++) {
    const col = new Float32Array(outH);
    const hlCol = new Float32Array(evenH);
    for (let y = 0; y < evenH; y++) hlCol[y] = matrixGet(hl, x, y);
    polyphaseConvolve1D(filter1, col, outH, hlCol, evenH, vLowP4, vLowP5, false);
    
    const hhCol = new Float32Array(oddH);
    for (let y = 0; y < oddH; y++) hhCol[y] = matrixGet(hh, x, y);
    polyphaseConvolve1D(filter2, col, outH, hhCol, oddH, vHighP4, vHighP5, true);
    
    for (let y = 0; y < outH; y++) tmpOdd.data[y * oddW + x] = col[y];
  }
  
  // ── Step 2: Horizontal pass (row by row) ──
  // output rows: filter1 * tmpEven_row + filter2 * tmpOdd_row
  for (let y = 0; y < outH; y++) {
    const row = new Float32Array(outW);
    const evenRow = new Float32Array(evenW);
    for (let x = 0; x < evenW; x++) evenRow[x] = tmpEven.data[y * evenW + x];
    polyphaseConvolve1D(filter1, row, outW, evenRow, evenW, hLowP4, hLowP5, false);
    
    const oddRow = new Float32Array(oddW);
    for (let x = 0; x < oddW; x++) oddRow[x] = tmpOdd.data[y * oddW + x];
    polyphaseConvolve1D(filter2, row, outW, oddRow, oddW, hHighP4, hHighP5, true);
    
    for (let x = 0; x < outW; x++) output.data[y * outW + x] = row[x];
  }
}

function waveletReconstructAll(
  filter1: Filter, filter2: Filter,
  pyramid: Pyramid, width: number, height: number
): Matrix {
  // From Ghidra wavelet_reconstruct_all @ 004bd1e0:
  // Reconstruct from deepest level upward.
  // At each level, the reconstruction output replaces the LL of the parent level.
  // Level N-1 → output → LL of level N-2
  // Level N-2 → output → LL of level N-3
  // ...
  // Level 0 → final output (full image size)
  
  for (let lev = pyramid.numLevels - 1; lev >= 0; lev--) {
    const level = pyramid.levels[lev];
    
    // The output size = LL.width + HL.width  ×  LL.height + LH.height
    // which equals the original dimensions at this decomposition level.
    const outW = level.subbands[0].width + level.subbands[2].width;
    const outH = level.subbands[0].height + level.subbands[1].height;
    
    const output = matrixCreate(outW, outH);
    waveletReconstructLevel(filter1, filter2, output, level);
    
    if (lev > 0) {
      // Feed output as LL of parent level
      pyramid.levels[lev - 1].subbands[0] = output;
    } else {
      return output;
    }
  }
  
  return pyramid.levels[0].subbands[0]; // unreachable
}

// ─── Band size calculation ────────────────────────────────────────────────
function calcBandSize(width: number, height: number, quant: number, orientation: number): number {
  // From Ghidra disassembly (missed by decompiler):
  // orientation==0: ceil(width / (quant*2)) * height * 2
  // orientation==1: ceil(height / (quant*2)) * width * 2
  // The *2 comes from FMUL DAT_004ed128 (=2.0) — accounts for interleaved block pairs
  if (orientation === 0) {
    return Math.ceil(width / (quant * 2)) * height * 2;
  } else {
    return Math.ceil(height / (quant * 2)) * width * 2;
  }
}

// ─── calc_bit_length ─────────────────────────────────────────────────────
// FUN_004b6ae0(bandValue, quant, rankTable):
//   quant >= 2: calc_rank_bit_length(rankTable, quant, bandValue, 0) → bit length from RANK table
//   quant < 2: bandValue * 2 + 1
// FUN_004b6b10: ceil(log2(result)) — but only for quant < 2 (for quant >= 2, rank table already stores bits)
// calc_bit_length: ceil(bitCount * 0.125) = bytes
function getRankBitLength(bandValue: number, quant: number, rankTable: number[][]): number {
  // This is FUN_004b6ae0: returns the total number of states (for quant < 2)
  // or the bit length directly from the rank table (for quant >= 2)
  if (quant >= 2) {
    return tableLookup(rankTable, quant, bandValue);
  } else {
    return bandValue * 2 + 1;
  }
}

function calcBitLength(bandValue: number, quant: number, rankTable: number[][]): number {
  let bitCount: number;
  if (quant >= 2) {
    // Rank table already stores bit counts
    bitCount = getRankBitLength(bandValue, quant, rankTable);
    if (bitCount < 0) bitCount = 0;
  } else {
    // For quant < 2: number of states = bandValue * 2 + 1
    // FUN_004b6b10 computes ceil(log2(states))
    const states = getRankBitLength(bandValue, quant, rankTable);
    bitCount = states <= 1 ? 0 : Math.ceil(Math.log2(states));
  }
  return Math.ceil(bitCount * DAT_004ed130);
}

// ─── level_scale_factor ─────────────────────────────────────────────────
function levelScaleFactor(extraBits: number): number {
  return (DAT_004ed1d0 - extraBits) * DAT_004ed1d8;
}

// ─── Block copy (FUN_004b6ba0) ──────────────────────────────────────────
function blockCopy(
  dst: Matrix, src: Float32Array, srcLen: number,
  startX: number, startY: number,
  strideX: number, strideY: number
): void {
  let x = startX, y = startY;
  for (let i = 0; i < srcLen; i++) {
    if (x < dst.width && y < dst.height && x >= 0 && y >= 0) {
      matrixSet(dst, x, y, src[i]);
    }
    x += strideX;
    y += strideY;
  }
}

// ─── itw_decode_band ───────────────────────────────────────────────────────
function itwDecodeBand(
  dst: Matrix,
  cursor: Cursor,
  quant: number,
  bandValue: number,
  bandScale: number,
  orientation: number,
  bandOffset: number,
  diffTable: number[][],   // exact counts T(q,m) — passed to fischerDecode for unranking
  rankTable: number[][],   // hardcoded bit lengths — used for reading codeword bits
  version: number
): void {
  const bandSize = calcBandSize(dst.width, dst.height, quant, orientation);
  if (bandSize === 0) return;
  
  const positions = new Int32Array(bandSize);
  const magnitudes = new Int32Array(bandSize);
  const extraBits = new Int32Array(bandSize);
  
  if (quant < 2) {
    // Simple path: direct codeword per position
    const bytesPerPos = calcBitLength(bandValue, quant, rankTable);
    const bufSize = DAT_004ed11c * bandSize;
    const inflated = cursor.copyStreamData(bufSize);
    const bs = new Bitstream(inflated);
    for (let i = 0; i < bandSize; i++) {
      positions[i] = bs.readBits(bytesPerPos * 8);
    }
    
    // Reconstruct coefficients (quant1 path)
    const range = bandValue * 2 + 1;
    const scale = (bandScale / bandValue) * bandOffset; // band_offset_scale
    // Wait, looking at coeff_reconstruct_dispatch: for quant==1:
    //   coeff_reconstruct_quant1(dst, positions, band_value, band_scale, band_offset, band_offset_scale)
    // But the args passed are: band_value=bandValue, band_scale=bandScale, band_offset=0.0 (reserved_zero in the call)
    // Actually re-reading itw_decode_main: 
    //   itw_decode_band(view, cursor, quant, quantSteps, bandScale, orientation, 0, bandOffset, ...)
    // And coeff_reconstruct_dispatch(dst, pos, mag, extra, quant, bandValue, bandScale, orientation, 0.0, bandOffset, rankTable)
    // coeff_reconstruct_quant1(dst, pos, bandValue, bandScale, param_9=0.0, param_10=bandOffset)
    // formula: (codeword % (bandValue*2+1) - bandValue) * (bandScale / bandValue) * bandOffset + 0.0
    // Wait, the args are: param_4=bandScale, param_5=param_9=0.0, param_6=param_10=bandOffset
    // So: value = (codeword % range - bandValue) * (bandScale / bandValue) * bandOffset + 0.0
    
    // Actually looking more carefully at coeff_reconstruct_quant1 signature:
    //   coeff_reconstruct_quant1(dst, pos_table, band_value, band_scale, band_offset, band_offset_scale)
    // And in itw_decode_main call to coeff_reconstruct_dispatch:
    //   (dst, pos, mag, extra, quant, bandValue, bandScale, orientation, 0.0, bandOffset, rankTable)
    // coeff_reconstruct_dispatch maps: param_7=bandScale, param_9=0.0, param_10=bandOffset
    // For quant1: param_4=bandScale, param_5=0.0=band_offset, param_6=bandOffset=band_offset_scale
    
    // So: value = (codeword % range - bandValue) * (bandScale / bandValue) * bandOffset + 0.0
    // Hmm that seems off. Let me re-check.
    // coeff_reconstruct_quant1(param_1=dst, param_2=pos_table, param_3=band_value, param_4=band_scale, param_5=band_offset, param_6=band_offset_scale)
    // formula: (codeword % (param_3*2+1) - param_3) * (param_4 / param_3) * param_6 + param_5
    // So: (codeword % range - bandValue) * (bandScale / bandValue) * bandOffset + 0.0
    
    const w = dst.width;
    const h = dst.height;
    let posIdx = 0;
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        if (posIdx < bandSize) {
          const codeword = positions[posIdx++];
          const val = (codeword % range - bandValue) * (bandScale / bandValue) * bandOffset;
          matrixSet(dst, x, y, val);
        }
      }
    }
  } else {
    // Fischer path: magnitude-based coding
    // Read magnitudes
    const magInflated = cursor.copyStreamData(bandSize);
    for (let i = 0; i < bandSize; i++) {
      magnitudes[i] = magInflated[i];
    }
    
    // Read extra bits (version 0 only)
    if (version === 0) {
      const bsData = new Uint8Array(cursor.remaining());
      const bs = new Bitstream(bsData);
      for (let i = 0; i < bandSize; i++) {
        if ((magnitudes[i] & DAT_004ed118) !== 0) {
          extraBits[i] = bs.readBits(4);
        } else {
          extraBits[i] = 0;
        }
        magnitudes[i] = magnitudes[i] & (DAT_004ed118 - 1); // mask off flag bit
      }
      // Update cursor position
      cursor.pos += bs.bytePos;
    } else {
      // version != 0: no extra bits
      extraBits.fill(0);
    }
    
    // Read codewords
    const cwBufSize = DAT_004ed11c * bandSize;
    const cwInflated = cursor.copyStreamData(cwBufSize);
    const cwBs = new Bitstream(cwInflated);
    for (let i = 0; i < bandSize; i++) {
      const bits = tableLookup(rankTable, quant, magnitudes[i]);
      positions[i] = bits > 0 ? cwBs.readBits(bits) : 0;
    }
    
    // Reconstruct coefficients (quant2 path)
    // From Ghidra coeff_reconstruct_quant2:
    //   fVar8 = (band_scale / band_value) * band_offset_scale  — stored as float32
    //   sf = level_scale_factor(extraBits)                     — stored as float32
    //   ratio = fVar8 / sf                                     — stored as float32
    //   fVar9 = decoded_int * ratio + band_offset              — stored as float32
    // From itw_decode_main dispatch: band_offset = 0.0, band_offset_scale = bandOffset
    // CRITICAL: All intermediate values are truncated to float32 in the original x87 code.
    const fVar8 = Math.fround(Math.fround(bandScale / bandValue) * bandOffset);
    
    let posIdx = 0;
    
    if (orientation === 1) {
      // Vertical blocks: outer by Y in steps of quant*2, inner by X
      // Each pair: block at (bx, by) stride (0,2) and block at (bx, by+1) stride (0,2)
      for (let by = 0; by < dst.height; by += quant * 2) {
        for (let bx = 0; bx < dst.width; bx++) {
          // First block: write at (bx, by), (bx, by+2), (bx, by+4), ...
          if (posIdx < bandSize) {
            const sf = Math.fround(levelScaleFactor(extraBits[posIdx]));
            const ratio = Math.fround(fVar8 / sf);
            const decoded = fischerDecode(quant, positions[posIdx], magnitudes[posIdx], diffTable);
            for (let k = 0; k < quant; k++) {
              const y = by + k * 2;
              if (y < dst.height) {
                matrixSet(dst, bx, y, Math.fround(decoded[k] * ratio));
              }
            }
            posIdx++;
          }
          // Second block: write at (bx, by+1), (bx, by+3), (bx, by+5), ...
          if (posIdx < bandSize) {
            const sf = Math.fround(levelScaleFactor(extraBits[posIdx]));
            const ratio = Math.fround(fVar8 / sf);
            const decoded = fischerDecode(quant, positions[posIdx], magnitudes[posIdx], diffTable);
            for (let k = 0; k < quant; k++) {
              const y = by + 1 + k * 2;
              if (y < dst.height) {
                matrixSet(dst, bx, y, Math.fround(decoded[k] * ratio));
              }
            }
            posIdx++;
          }
        }
      }
    } else {
      // Horizontal blocks (orientation == 0): outer by X in steps of quant*2, inner by Y
      for (let bx = 0; bx < dst.width; bx += quant * 2) {
        for (let by = 0; by < dst.height; by++) {
          // First block: write at (bx, by), (bx+2, by), (bx+4, by), ...
          if (posIdx < bandSize) {
            const sf = Math.fround(levelScaleFactor(extraBits[posIdx]));
            const ratio = Math.fround(fVar8 / sf);
            const decoded = fischerDecode(quant, positions[posIdx], magnitudes[posIdx], diffTable);
            for (let k = 0; k < quant; k++) {
              const x = bx + k * 2;
              if (x < dst.width) {
                matrixSet(dst, x, by, Math.fround(decoded[k] * ratio));
              }
            }
            posIdx++;
          }
          // Second block: write at (bx+1, by), (bx+3, by), (bx+5, by), ...
          if (posIdx < bandSize) {
            const sf = Math.fround(levelScaleFactor(extraBits[posIdx]));
            const ratio = Math.fround(fVar8 / sf);
            const decoded = fischerDecode(quant, positions[posIdx], magnitudes[posIdx], diffTable);
            for (let k = 0; k < quant; k++) {
              const x = bx + 1 + k * 2;
              if (x < dst.width) {
                matrixSet(dst, x, by, Math.fround(decoded[k] * ratio));
              }
            }
            posIdx++;
          }
        }
      }
    }
  }
}

// ─── Read LL band ──────────────────────────────────────────────────────────
// From Ghidra read_ll_band: outer loop = width (x), inner loop = height (y)
// The bytes are stored column-major in the stream.
function readLLBand(cursor: Cursor, matrix: Matrix): void {
  for (let x = 0; x < matrix.width; x++) {
    for (let y = 0; y < matrix.height; y++) {
      const byte = cursor.readByte();
      matrixSet(matrix, x, y, byte);
    }
  }
}

// ─── Subband view mapping ──────────────────────────────────────────────────
// Maps the flat subband view array to pyramid subbands.
// From itw_decode_main:
// views[0] = level[0].subband[0] (LL at level 0)
// views[1] = level[0].subband[1] (LH at level 0)
// For each level i (1..numLevels-1):
//   views[2 + (i-1)*3 + 0] = level[i].subband[0] (LL)
//   views[2 + (i-1)*3 + 1] = level[i].subband[1] (LH)
//   views[2 + (i-1)*3 + 2] = level[i].subband[2] (HL)
// views[local_a0] = level[numLevels-1].subband[3] (HH at deepest)

// Actually wait, looking at the code again more carefully:
// Level 0: band 0 (LL), band 1 (LH)
// Level 1..N-1: band 0 (LL), band 1 (LH), band 2 (HL)
// Last: HH of deepest level
// 
// But the ORIENTATION and quant arrays are only for "detail" bands (local_a0 elements).
// views has local_90 elements total, with the LAST one (views[local_a0]) being the LL of deepest.
// Actually re-reading: piVar11 = piVar9 + local_a0 points to the last view slot,
// and it's set to level[numLevels-1].subband[3] = HH of deepest level.
// Then read_ll_band writes to this last view.
// 
// WAIT. The code says:
//   piVar11 = (int *)pyramid_get_level(piVar8, iVar22 - 1);  [deepest level]
//   piVar12 = level_get_subband(piVar11, 3);  [HH of deepest]
//   piVar11 = piVar9 + local_a0;  [last view slot]
//   *piVar11 = matrix_create_view(piVar12)
// Then later: read_ll_band(cursor, *(*piVar11 + 4))
// So the last view (index local_a0) is the HH of the deepest level,
// and the LL band is read INTO that?? That doesn't make sense.
// Unless... level_get_subband(level, 3) for the deepest level IS the LL band.
// Let me re-check what subband index 3 is...

// In the pyramid, level[numLevels-1] has subbands for the coarsest decomposition.
// The "LL" at the very deepest level is a special case — it's the DC coefficients.
// In a typical wavelet codec, the deepest LL is stored separately.
// Here, subband 3 of the deepest level might be repurposed as the LL storage.

// This is getting complicated. Let me just use a simpler mapping:
// For the subband views that get decoded by itw_decode_band:
// - views 0..(local_a0-1) are the detail subbands
// - view local_a0 is the LL of the deepest level (stored as subband[3])

// For 3 levels (local_90=9, local_a0=8):
// views[0] = L0.LL, views[1] = L0.LH
// views[2] = L1.LL, views[3] = L1.LH, views[4] = L1.HL
// views[5] = L2.LL, views[6] = L2.LH, views[7] = L2.HL
// views[8] = L2.HH (used for LL band reading)

// For 4 levels (local_90=12, local_a0=11):
// views[0] = L0.LL, views[1] = L0.LH
// views[2] = L1.LL, ..., views[4] = L1.HL
// views[5] = L2.LL, ..., views[7] = L2.HL
// views[8] = L3.LL, ..., views[10] = L3.HL
// views[11] = L3.HH

// Quant steps from local_3c: [8, 8, 4, 4, 4, 2, 2, 2, 1, 1, 1]
// For 3 levels, only first 8 are used (detail bands).
// For 4 levels, all 11 are used.

// ─── Main decode function ──────────────────────────────────────────────────
export function decode0300(buf: Uint8Array, payloadOffset: number, width: number, height: number, opts?: { zeroDetailBands?: boolean; bandMask?: number }): DecodeResult {
  // Read BE32 payload length, then the payload starts after it
  if (payloadOffset + 4 > buf.length) throw new ITWError("missing wavelet length");
  const payloadLen = readBE32From2BE16(buf, payloadOffset);
  const payloadStart = payloadOffset + 4;
  if (payloadStart + payloadLen > buf.length) throw new ITWError("wavelet payload overruns file");
  
  // Build Fischer tables
  const baseTable = buildBaseTable();        // cumulative counts — used to build diff table
  const diffTable = buildDiffTable(baseTable); // exact counts T(q,m) — used by fischerDecode for unranking
  const rankTable = buildRankTable();        // hardcoded bit lengths — used for codeword reading
  
  // Quant step sizes per band
  const quantSteps = [8, 8, 4, 4, 4, 2, 2, 2, 1, 1, 1];
  
  // Read 3 header bytes from payload
  const cursor = new Cursor(buf, payloadStart);
  const version = cursor.readByte();     // DAT_00516c78
  const numLevels = cursor.readByte();   // 3 or 4
  const filterType = cursor.readByte();  // 0 or 1
  
  if (numLevels !== 3 && numLevels !== 4) {
    throw new ITWError(`unsupported wavelet level count: ${numLevels}`);
  }
  
  const totalSubbands = numLevels === 3 ? 9 : 12;   // local_90
  const detailSubbands = numLevels === 3 ? 8 : 11;  // local_a0
  
  // Initialize wavelet filters (synthesis only needed for reconstruction)
  const { reconstructFilter1, reconstructFilter2 } = initFilters(filterType);
  
  // Create wavelet pyramid
  const pyramid = pyramidCreate(width, height, numLevels);
  
  // Zero out level 0, band 2 in Ghidra = L0.HH in our mapping (subbands[3])
  // Ghidra subband order: [0]=HL, [1]=LH, [2]=HH, [3]=LL
  // Our subband order:    [0]=LL, [1]=LH, [2]=HL, [3]=HH
  pyramid.levels[0].subbands[3].data.fill(0); // L0.HH zeroed
  
  // Build subband view mapping to match Ghidra's itw_decode_main:
  // Ghidra maps:
  //   views[0] = level0.subband[0] = L0.HL → our subbands[2]
  //   views[1] = level0.subband[1] = L0.LH → our subbands[1]
  //   For levels 1+:
  //     views[2+3*(i-1)+0] = Li.subband[0] = Li.HL → our subbands[2]
  //     views[2+3*(i-1)+1] = Li.subband[1] = Li.LH → our subbands[1]
  //     views[2+3*(i-1)+2] = Li.subband[2] = Li.HH → our subbands[3]
  //   views[detailSubbands] = deepest_level.subband[3] = LL → our subbands[0]
  const views: Matrix[] = [];
  views.push(pyramid.levels[0].subbands[2]); // L0.HL
  views.push(pyramid.levels[0].subbands[1]); // L0.LH
  for (let i = 1; i < numLevels; i++) {
    views.push(pyramid.levels[i].subbands[2]); // Li.HL
    views.push(pyramid.levels[i].subbands[1]); // Li.LH
    views.push(pyramid.levels[i].subbands[3]); // Li.HH
  }
  // The last view is the LL of deepest level — used as LL band target
  const llBandMatrix = pyramid.levels[numLevels - 1].subbands[0];
  views.push(llBandMatrix);
  
  // Per-frame loop (typically 1 iteration for param_1[5]=1)
  // The number of frames is stored in the image header at offset 0x14 (field [5]).
  // For our purposes, it's always 1 frame.
  const numFrames = 1;
  
  for (let frame = 0; frame < numFrames; frame++) {
    // Read orientation flags (1 bit per detail subband)
    const orientBsData = buf.subarray(cursor.pos);
    const orientBs = new Bitstream(orientBsData);
    const orientations = new Int32Array(detailSubbands);
    for (let i = 0; i < detailSubbands; i++) {
      orientations[i] = orientBs.readBits(1);
    }
    cursor.pos += orientBs.bytePos;
    
    // Read per-band parameters
    const bandQuantSteps = new Uint32Array(detailSubbands);
    const bandScales = new Float32Array(detailSubbands);
    const bandOffsets = new Float32Array(detailSubbands);
    
    for (let i = 0; i < detailSubbands; i++) {
      bandQuantSteps[i] = cursor.readBE16();
      const scaleQ15 = cursor.readBE16();
      bandScales[i] = q15ToFloat(scaleQ15);
      const offsetQ15 = cursor.readBE16();
      bandOffsets[i] = q15ToFloat(offsetQ15);
    }
    
    // Read min/max range
    const minVal = cursor.readBE16();
    const maxVal = cursor.readBE16();
    const range = maxVal - minVal;
    
    // Decode detail subbands
    for (let i = 0; i < detailSubbands; i++) {
      const view = views[i];
      itwDecodeBand(
        view, cursor, quantSteps[i], bandQuantSteps[i],
        bandScales[i], orientations[i], bandOffsets[i],
        diffTable, rankTable, version
      );
    }
    
    // Debug: zero out all detail bands to isolate LL-only reconstruction
    if (opts?.zeroDetailBands) {
      for (let i = 0; i < detailSubbands; i++) {
        views[i].data.fill(0);
      }
    }
    // Debug: only keep specific detail bands (bandMask is a bitmask, bit i = keep band i)
    if (opts?.bandMask !== undefined) {
      for (let i = 0; i < detailSubbands; i++) {
        if ((opts.bandMask & (1 << i)) === 0) {
          views[i].data.fill(0);
        }
      }
    }
    
    // Read LL band (raw bytes)
    readLLBand(cursor, llBandMatrix);
    
    // Post-process LL band: scale/clamp
    // From Ghidra decompilation + ASM of itw_decode_main (0x004b7e36-0x004b7e87):
    //   uVar20 = read_be_multibyte(2)  → first_val (min_val)
    //   uVar16 = read_be_multibyte(2)  → second_val (max_val)
    //   fVar3 = (float)(uVar16 - uVar20)  → range
    //   local_44 = (fVar3 + (float)uVar20) * 0.5  → center  [stored as float32]
    //   FSUBRP at 004b7e7f: Intel opcode DE E1 = ST(1) ← ST(0) - ST(1)
    //     FPU state: ST(0) = first_val, ST(1) = range
    //     Result: first_val - range  (POSITIVE for normal images)
    //   llScale_raw = (first_val - range) * 0.5  [stored as float32]
    //   llScale = (double)llScale_raw * (1.0/127.0)
    //   value = (pixel - 127.0) * llScale + center
    //   clamp: range ≤ value ≤ first_val
    //
    // For 26.ITW: first_val=3522, range=1705
    //   center = (1705+3522)*0.5 = 2613.5
    //   llScale_raw = (3522-1705)*0.5 = 908.5
    //   pixel 0   → (0-127)*7.1535+2613.5 = 1705 (= range, lower bound) ✓
    //   pixel 254 → (254-127)*7.1535+2613.5 = 3522 (= first_val, upper bound) ✓
    const centerF32 = Math.fround((range + minVal) * DAT_004ed190);
    const llScaleRawF32 = Math.fround((minVal - range) * 0.5); // first_val - range (POSITIVE)
    const llScale = llScaleRawF32 * DAT_004ed198; // float32 * double → double
    const llCenter = centerF32; // loaded from float32 → extended to double
    const clampLo = Math.min(minVal, range);
    const clampHi = Math.max(minVal, range);
    
    const llData = llBandMatrix.data;
    const llCount = llBandMatrix.width * llBandMatrix.height;
    for (let i = 0; i < llCount; i++) {
      let val = (llData[i] - DAT_004ed1a0) * llScale + llCenter;
      if (val <= clampLo) val = clampLo;
      else if (val >= clampHi) val = clampHi;
      llData[i] = val;
    }
  }
  
  // Wavelet reconstruction
  const result = waveletReconstructAll(reconstructFilter1, reconstructFilter2, pyramid, width, height);
  
  // Convert float matrix to grayscale bytes
  // From disassembly of FUN_004b5b30:
  //   CMP dword ptr [EDI],0x0  — compare float as integer (≤0 for negative/zero floats)
  //   JLE → use 0
  //   FCOM against 255.0 → clamp to min(val, 255.0)
  //   CALL ftol → MSVC truncation toward zero (NOT round-to-nearest)
  //   MOV byte ptr [EBX-1],AL  — store as byte
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let val = matrixGet(result, x, y);
      // Clamp float to [0, 255] THEN truncate (matching original ftol)
      if (val <= 0) {
        val = 0;
      } else if (val > 255) {
        val = 255;
      }
      pixels[y * width + x] = Math.trunc(val);
    }
  }
  
  return { width, height, pixels };
}
