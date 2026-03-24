import { describe, it, expect } from 'vitest';
import { _internals, decode0300 } from '../src/decode0300';
import { readFileSync, existsSync } from 'fs';
import { parseHeader } from '../src/itw';
import { join } from 'path';

const {
  deriveMirror,
  buildFilterCoeffs,
  initFilters,
  buildBaseTable,
  buildDiffTable,
  buildRankTable,
  tableLookup,
  fischerDecode,
  splitEvenOdd,
  calcBandSize,
  levelScaleFactor,
  q15ToFloat,
  hexToFloat,
  polyphaseConvolve1D,
  matrixCreate,
  matrixGet,
  matrixSet,
  edgeExtend,
  Cursor,
  Bitstream,
} = _internals;

// ─── Helper ──────────────────────────────────────────────────────────────────

function samplePath(name: string) {
  return join(__dirname, '..', 'samples', '1', '03', '95', name);
}

// ─── hexToFloat ──────────────────────────────────────────────────────────────

describe('hexToFloat', () => {
  it('converts known IEEE 754 hex to float', () => {
    expect(hexToFloat(0x3f800000)).toBeCloseTo(1.0, 6);
    expect(hexToFloat(0x40000000)).toBeCloseTo(2.0, 6);
    expect(hexToFloat(0x00000000)).toBe(0.0);
    expect(hexToFloat(0xbf800000)).toBeCloseTo(-1.0, 6);
  });

  it('converts filter coefficients correctly', () => {
    // 0x3e800000 = 0.25
    expect(hexToFloat(0x3e800000)).toBeCloseTo(0.25, 6);
    // 0x3f19999a ≈ 0.6
    expect(hexToFloat(0x3f19999a)).toBeCloseTo(0.6, 4);
  });
});

// ─── q15ToFloat ──────────────────────────────────────────────────────────────

describe('q15ToFloat', () => {
  it('divides by 32.0', () => {
    expect(q15ToFloat(320)).toBeCloseTo(10.0, 6);
    expect(q15ToFloat(0)).toBe(0);
  });

  it('handles negative values (sign extension)', () => {
    // 0xFFFF → -1 as signed 16-bit → -1/32 = -0.03125
    expect(q15ToFloat(0xFFFF)).toBeCloseTo(-1 / 32, 6);
  });
});

// ─── levelScaleFactor ────────────────────────────────────────────────────────

describe('levelScaleFactor', () => {
  it('returns 1.0 for extraBits=0', () => {
    expect(levelScaleFactor(0)).toBeCloseTo(1.0, 6);
  });

  it('returns 0.5 for extraBits=8', () => {
    expect(levelScaleFactor(8)).toBeCloseTo(0.5, 6);
  });

  it('returns 0.0 for extraBits=16', () => {
    expect(levelScaleFactor(16)).toBeCloseTo(0.0, 6);
  });
});

// ─── splitEvenOdd ────────────────────────────────────────────────────────────

describe('splitEvenOdd', () => {
  it('splits even numbers equally', () => {
    expect(splitEvenOdd(10)).toEqual([5, 5]);
    expect(splitEvenOdd(0)).toEqual([0, 0]);
  });

  it('splits odd numbers: even part is (n+1)/2', () => {
    expect(splitEvenOdd(7)).toEqual([4, 3]);
    expect(splitEvenOdd(1)).toEqual([1, 0]);
    expect(splitEvenOdd(239)).toEqual([120, 119]);
  });
});

// ─── calcBandSize ────────────────────────────────────────────────────────────

describe('calcBandSize', () => {
  it('orientation 0: ceil(w / (q*2)) * h * 2', () => {
    expect(calcBandSize(158, 119, 8, 0)).toBe(Math.ceil(158 / 16) * 119 * 2);
  });

  it('orientation 1: ceil(h / (q*2)) * w * 2', () => {
    expect(calcBandSize(158, 119, 8, 1)).toBe(Math.ceil(119 / 16) * 158 * 2);
  });

  it('handles exact division', () => {
    expect(calcBandSize(16, 10, 2, 0)).toBe(Math.ceil(16 / 4) * 10 * 2);
  });
});

// ─── deriveMirror ────────────────────────────────────────────────────────────

describe('deriveMirror', () => {
  it('produces correct sign pattern for 5-tap (center=2)', () => {
    const input = [1, 2, 3, 4, 5];
    const result = deriveMirror(input, 2);
    // Signs from center down: +1, -1, +1 → indices 2,1,0
    // Signs from center+1 up: -1, +1 → indices 3,4
    expect(result).toEqual([1, -2, 3, -4, 5]);
  });

  it('produces correct sign pattern for 7-tap (center=3)', () => {
    const input = [1, 2, 3, 4, 5, 6, 7];
    const result = deriveMirror(input, 3);
    // First loop (3→0): +1, -1, +1, -1
    // Second loop (4→6): -1, +1, -1
    expect(result).toEqual([-1, 2, -3, 4, -5, 6, -7]);
  });

  it('produces correct sign pattern for 9-tap (center=4)', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const result = deriveMirror(input, 4);
    // First loop (4→0): +1, -1, +1, -1, +1
    // Second loop (5→8): -1, +1, -1, +1
    expect(result).toEqual([1, -2, 3, -4, 5, -6, 7, -8, 9]);
  });

  it('produces highpass g1 filter (near-zero DC sum) for type 1', () => {
    const s = Math.sqrt(2);
    const h0 = [
      hexToFloat(0xbc2f8af9) * s, hexToFloat(0xbd5b6db7) * s,
      hexToFloat(0x3e857c58) * s, hexToFloat(0x3f1b6db7) * s,
      hexToFloat(0x3e857c58) * s, hexToFloat(0xbd5b6db7) * s,
      hexToFloat(0xbc2f8af9) * s,
    ];
    const g1 = deriveMirror(h0, 3);
    const dcSum = g1.reduce((a, b) => a + b, 0);
    expect(Math.abs(dcSum)).toBeLessThan(0.01); // highpass: DC ≈ 0
  });

  it('produces lowpass h1 (non-zero DC sum) for type 1', () => {
    const s = Math.sqrt(2);
    const h1 = [
      hexToFloat(0xbd4ccccd) * s, hexToFloat(0x3e800000) * s,
      hexToFloat(0x3f19999a) * s, hexToFloat(0x3e800000) * s,
      hexToFloat(0xbd4ccccd) * s,
    ];
    const dcSum = h1.reduce((a, b) => a + b, 0);
    expect(dcSum).toBeCloseTo(Math.sqrt(2), 2); // lowpass: DC ≈ √2
  });
});

// ─── buildFilterCoeffs ───────────────────────────────────────────────────────

describe('buildFilterCoeffs', () => {
  it('type 0: returns 9-tap low and 7-tap high', () => {
    const { analysisLowLen, analysisHighLen, analysisLowCoeffs, analysisHighCoeffs } = buildFilterCoeffs(0);
    expect(analysisLowLen).toBe(9);
    expect(analysisHighLen).toBe(7);
    expect(analysisLowCoeffs).toHaveLength(9);
    expect(analysisHighCoeffs).toHaveLength(7);
  });

  it('type 1: returns 7-tap low and 5-tap high, scaled by √2', () => {
    const { analysisLowLen, analysisHighLen, analysisLowCoeffs } = buildFilterCoeffs(1);
    expect(analysisLowLen).toBe(7);
    expect(analysisHighLen).toBe(5);
    // Unscaled center coeff ≈ 0.6071, scaled ≈ 0.8586
    expect(analysisLowCoeffs[3]).toBeCloseTo(hexToFloat(0x3f1b6db7) * Math.sqrt(2), 4);
  });

  it('type 0: filters are symmetric', () => {
    const { analysisLowCoeffs, analysisHighCoeffs } = buildFilterCoeffs(0);
    for (let i = 0; i < analysisLowCoeffs.length; i++) {
      expect(analysisLowCoeffs[i]).toBeCloseTo(analysisLowCoeffs[analysisLowCoeffs.length - 1 - i], 6);
    }
    for (let i = 0; i < analysisHighCoeffs.length; i++) {
      expect(analysisHighCoeffs[i]).toBeCloseTo(analysisHighCoeffs[analysisHighCoeffs.length - 1 - i], 6);
    }
  });

  it('throws for unknown filter type', () => {
    expect(() => buildFilterCoeffs(2)).toThrow('unsupported filter type');
  });
});

// ─── initFilters ─────────────────────────────────────────────────────────────

describe('initFilters', () => {
  it('returns h1 (parity=0) and g1 (parity=1) for reconstruction', () => {
    const { reconstructFilter1, reconstructFilter2 } = initFilters(1);
    expect(reconstructFilter1.parity).toBe(0);
    expect(reconstructFilter2.parity).toBe(1);
    expect(reconstructFilter1.length).toBe(5); // analysis high
    expect(reconstructFilter2.length).toBe(7); // synthesis high (same length as analysis low)
  });

  it('g1 has near-zero DC sum (highpass)', () => {
    const { reconstructFilter2 } = initFilters(1);
    const dc = reconstructFilter2.coeffs.reduce((a, b) => a + b, 0);
    expect(Math.abs(dc)).toBeLessThan(0.01);
  });

  it('h1 has non-zero DC sum (lowpass)', () => {
    const { reconstructFilter1 } = initFilters(1);
    const dc = reconstructFilter1.coeffs.reduce((a, b) => a + b, 0);
    expect(dc).toBeCloseTo(Math.sqrt(2), 2);
  });
});

// ─── Fischer tables ──────────────────────────────────────────────────────────

describe('Fischer tables', () => {
  const baseTable = buildBaseTable();
  const diffTable = buildDiffTable(baseTable);
  const rankTable = buildRankTable();

  describe('buildBaseTable', () => {
    it('base[0][m] = 1 for all m (trivial: 0-tuple)', () => {
      for (let m = 0; m < 30; m++) {
        expect(baseTable[0][m]).toBe(1);
      }
    });

    it('base[q][0] = 1 for all q', () => {
      for (let q = 0; q < 9; q++) {
        expect(baseTable[q][0]).toBe(1);
      }
    });

    it('cumT(1, m) = 2m + 1 (one position: values from -m to +m)', () => {
      for (let m = 0; m < 20; m++) {
        expect(baseTable[1][m]).toBe(2 * m + 1);
      }
    });

    it('cumT(2, 1) = 5 (pairs with |a|+|b| ≤ 1: (0,0),(1,0),(-1,0),(0,1),(0,-1))', () => {
      expect(baseTable[2][1]).toBe(5);
    });
  });

  describe('buildDiffTable', () => {
    it('diff[q][0] = 1 for all q', () => {
      for (let q = 0; q < 9; q++) {
        expect(diffTable[q][0]).toBe(1);
      }
    });

    it('diff[0][m] = 0 for m >= 1', () => {
      for (let m = 1; m < 30; m++) {
        expect(diffTable[0][m]).toBe(0);
      }
    });

    it('T(1, m) = 2 for m >= 1 (one position: +m or -m)', () => {
      for (let m = 1; m < 20; m++) {
        expect(diffTable[1][m]).toBe(2);
      }
    });

    it('T(2, 1) = 4 (pairs with |a|+|b| = 1: (1,0),(-1,0),(0,1),(0,-1))', () => {
      expect(diffTable[2][1]).toBe(4);
    });
  });

  describe('buildRankTable', () => {
    it('rankTable[2][0] = 0', () => {
      expect(rankTable[2][0]).toBe(0);
    });

    it('rankTable[2][1] = 2', () => {
      expect(rankTable[2][1]).toBe(2);
    });

    it('rankTable[4][1] = 3', () => {
      expect(rankTable[4][1]).toBe(3);
    });

    it('rankTable[8][1] = 4', () => {
      expect(rankTable[8][1]).toBe(4);
    });

    it('non-standard quant rows are all zeros', () => {
      for (let m = 0; m < 31; m++) {
        expect(rankTable[3][m]).toBe(0);
        expect(rankTable[5][m]).toBe(0);
      }
    });
  });

  describe('tableLookup', () => {
    it('returns value for in-bounds access', () => {
      expect(tableLookup(diffTable, 1, 0)).toBe(1);
    });

    it('returns 0 for out-of-bounds row', () => {
      expect(tableLookup(diffTable, 99, 0)).toBe(0);
    });

    it('returns 0 for out-of-bounds column', () => {
      expect(tableLookup(diffTable, 0, 9999)).toBe(0);
    });

    it('returns 0 for negative indices', () => {
      expect(tableLookup(diffTable, -1, 0)).toBe(0);
      expect(tableLookup(diffTable, 0, -1)).toBe(0);
    });
  });
});

// ─── fischerDecode ───────────────────────────────────────────────────────────

describe('fischerDecode', () => {
  const baseTable = buildBaseTable();
  const diffTable = buildDiffTable(baseTable);

  it('returns all zeros for magnitudeSum=0', () => {
    expect(fischerDecode(4, 0, 0, diffTable)).toEqual([0, 0, 0, 0]);
  });

  it('decodes codeword=0, mag=1 for outLen=2 → [+1, 0]', () => {
    // T(1, 1) = 2. zeroCount = T(1,1) = 2.
    // codeword 0 < 0 + 2 → zero at position 0? No wait:
    // codeword=0, runningTotal=0 → codeword == runningTotal → break, set out[0]=0
    // remaining=1 > 0 → fixup: out[1] = 1 - abs(out[0]) = 1
    expect(fischerDecode(2, 0, 1, diffTable)).toEqual([0, 1]);
  });

  it('sum of absolute values equals magnitudeSum', () => {
    // Test various codewords for quant=4, mag=3
    for (let cw = 0; cw < 10; cw++) {
      const result = fischerDecode(4, cw, 3, diffTable);
      const absSum = result.reduce((a, v) => a + Math.abs(v), 0);
      expect(absSum).toBe(3);
    }
  });

  it('different codewords produce different tuples', () => {
    // T(2, 3) = C(2,1)*C(2,0)*2 + C(2,2)*C(1,1)*4 = 4 + 4 = 8? Let's compute:
    // cumT(2,3) = base[2][3]. Find valid codeword range.
    const maxCW = tableLookup(diffTable, 2, 3); // exact count T(2,3)
    const seen = new Set<string>();
    for (let cw = 0; cw < maxCW; cw++) {
      const result = fischerDecode(2, cw, 3, diffTable);
      seen.add(result.join(','));
    }
    expect(seen.size).toBe(maxCW);
  });

  it('output has correct length', () => {
    expect(fischerDecode(8, 0, 5, diffTable)).toHaveLength(8);
    expect(fischerDecode(1, 0, 3, diffTable)).toHaveLength(1);
  });
});

// ─── Bitstream ───────────────────────────────────────────────────────────────

describe('Bitstream', () => {
  it('reads bits LSB-first', () => {
    // byte 0b10110100 = 0xB4
    const bs = new Bitstream(new Uint8Array([0xB4]));
    expect(bs.readBits(1)).toBe(0); // bit 0
    expect(bs.readBits(1)).toBe(0); // bit 1
    expect(bs.readBits(1)).toBe(1); // bit 2
    expect(bs.readBits(1)).toBe(0); // bit 3
    expect(bs.readBits(1)).toBe(1); // bit 4
    expect(bs.readBits(1)).toBe(1); // bit 5
    expect(bs.readBits(1)).toBe(0); // bit 6
    expect(bs.readBits(1)).toBe(1); // bit 7
  });

  it('reads multi-bit values correctly', () => {
    // 0xFF → first 4 bits = 0b1111 = 15
    const bs = new Bitstream(new Uint8Array([0xFF]));
    expect(bs.readBits(4)).toBe(0x0F);
    expect(bs.readBits(4)).toBe(0x0F);
  });

  it('crosses byte boundaries', () => {
    // bytes: 0x03 (0b00000011), 0x04 (0b00000100)
    const bs = new Bitstream(new Uint8Array([0x03, 0x04]));
    expect(bs.readBits(8)).toBe(0x03);
    expect(bs.readBits(8)).toBe(0x04);
  });

  it('reads 0 bits', () => {
    const bs = new Bitstream(new Uint8Array([0xFF]));
    expect(bs.readBits(0)).toBe(0);
  });

  it('bytePos tracks correctly', () => {
    const bs = new Bitstream(new Uint8Array([0xFF, 0xFF]));
    expect(bs.bytePos).toBe(0);
    bs.readBits(1);
    expect(bs.bytePos).toBe(1); // partial byte → ceil
    bs.readBits(7);
    expect(bs.bytePos).toBe(1); // exactly 8 bits = 1 byte
    bs.readBits(1);
    expect(bs.bytePos).toBe(2);
  });
});

// ─── Cursor ──────────────────────────────────────────────────────────────────

describe('Cursor', () => {
  it('reads bytes sequentially', () => {
    const c = new Cursor(new Uint8Array([0x10, 0x20, 0x30]), 0);
    expect(c.readByte()).toBe(0x10);
    expect(c.readByte()).toBe(0x20);
    expect(c.readByte()).toBe(0x30);
  });

  it('reads BE16', () => {
    const c = new Cursor(new Uint8Array([0xAB, 0xCD]), 0);
    expect(c.readBE16()).toBe(0xABCD);
  });

  it('advances position correctly', () => {
    const c = new Cursor(new Uint8Array([0, 0, 0, 0, 0]), 0);
    expect(c.pos).toBe(0);
    c.readByte();
    expect(c.pos).toBe(1);
    c.readBE16();
    expect(c.pos).toBe(3);
  });

  it('respects initial offset', () => {
    const c = new Cursor(new Uint8Array([0x00, 0x00, 0xAA]), 2);
    expect(c.readByte()).toBe(0xAA);
  });
});

// ─── Polyphase convolution ───────────────────────────────────────────────────

describe('polyphaseConvolve1D', () => {
  it('identity filter passes through source values', () => {
    // A "filter" of length 1, center=0, parity=0 with coeffs=[1.0]
    // should output src[i/2] for even i (and skip odd)
    const filter = { coeffs: [1.0], length: 1, center: 0, parity: 0 };
    const src = new Float32Array([10, 20, 30]);
    const dst = new Float32Array(6);
    polyphaseConvolve1D(filter, dst, 6, src, 3, 1, 1, false);
    // Even outputs should be src values, odd outputs 0
    expect(dst[0]).toBeCloseTo(10);
    expect(dst[2]).toBeCloseTo(20);
    expect(dst[4]).toBeCloseTo(30);
  });

  it('add mode accumulates into dst', () => {
    const filter = { coeffs: [1.0], length: 1, center: 0, parity: 0 };
    const src = new Float32Array([5, 5, 5]);
    const dst = new Float32Array([1, 1, 1, 1, 1, 1]);
    polyphaseConvolve1D(filter, dst, 6, src, 3, 1, 1, true);
    expect(dst[0]).toBeCloseTo(6); // 1 + 5
    expect(dst[2]).toBeCloseTo(6);
  });
});

// ─── edgeExtend ──────────────────────────────────────────────────────────────

describe('edgeExtend', () => {
  const src = new Float32Array([10, 20, 30, 40, 50]);

  it('returns value for in-bounds index', () => {
    expect(edgeExtend(src, 2, 5, 0)).toBe(30);
  });

  it('reflects for negative index', () => {
    // boundary=0: src[0 - (-1)] = src[1]
    expect(edgeExtend(src, -1, 5, 0)).toBe(20);
  });

  it('reflects for index past end', () => {
    // boundary = 2*5-2 = 8: src[8 - 5] = src[3]
    expect(edgeExtend(src, 5, 5, 8)).toBe(40);
  });
});

// ─── Matrix ──────────────────────────────────────────────────────────────────

describe('Matrix', () => {
  it('stores and retrieves values', () => {
    const m = matrixCreate(3, 2);
    matrixSet(m, 1, 0, 42.5);
    expect(matrixGet(m, 1, 0)).toBe(42.5);
  });

  it('has correct dimensions', () => {
    const m = matrixCreate(10, 20);
    expect(m.width).toBe(10);
    expect(m.height).toBe(20);
    expect(m.data.length).toBe(200);
  });

  it('initializes to zero', () => {
    const m = matrixCreate(5, 5);
    for (let i = 0; i < 25; i++) {
      expect(m.data[i]).toBe(0);
    }
  });
});

// ─── Integration: decode sample files ────────────────────────────────────────

const hasSamples = existsSync(samplePath('26.ITW'));

describe('decode0300 integration', () => {
  it.skipIf(!hasSamples)('decodes 26.ITW without errors', () => {
    const buf = readFileSync(samplePath('26.ITW'));
    const { header, payloadOffset } = parseHeader(buf);
    const result = decode0300(buf, payloadOffset, header.width, header.height);
    expect(result.width).toBe(316);
    expect(result.height).toBe(238);
    expect(result.pixels.length).toBe(316 * 238);
  });

  it.skipIf(!hasSamples)('output pixels are in [0, 255]', () => {
    const buf = readFileSync(samplePath('26.ITW'));
    const { header, payloadOffset } = parseHeader(buf);
    const result = decode0300(buf, payloadOffset, header.width, header.height);
    for (let i = 0; i < result.pixels.length; i++) {
      expect(result.pixels[i]).toBeGreaterThanOrEqual(0);
      expect(result.pixels[i]).toBeLessThanOrEqual(255);
    }
  });

  it.skipIf(!hasSamples)('decodes all sample files', () => {
    for (const name of ['00.ITW', '26.ITW', '30.ITW', '60.ITW', '83.ITW']) {
      const buf = readFileSync(samplePath(name));
      const { header, payloadOffset } = parseHeader(buf);
      const result = decode0300(buf, payloadOffset, header.width, header.height);
      expect(result.pixels.length).toBe(header.width * header.height);
    }
  });

  it.skipIf(!hasSamples)('zeroDetailBands produces LL-only output', () => {
    const buf = readFileSync(samplePath('26.ITW'));
    const { header, payloadOffset } = parseHeader(buf);
    const normal = decode0300(buf, payloadOffset, header.width, header.height, { returnFloat: true });
    const llOnly = decode0300(buf, payloadOffset, header.width, header.height, { zeroDetailBands: true, returnFloat: true });

    // LL-only should differ from normal (detail bands contribute)
    let diffCount = 0;
    for (let i = 0; i < normal.floatData!.length; i++) {
      if (Math.abs(normal.floatData![i] - llOnly.floatData![i]) > 0.01) diffCount++;
    }
    expect(diffCount).toBeGreaterThan(normal.floatData!.length * 0.1);
  });

  it.skipIf(!hasSamples)('detailGain=0 is equivalent to zeroDetailBands', () => {
    const buf = readFileSync(samplePath('26.ITW'));
    const { header, payloadOffset } = parseHeader(buf);
    const llOnly = decode0300(buf, payloadOffset, header.width, header.height, { zeroDetailBands: true });
    const gainZero = decode0300(buf, payloadOffset, header.width, header.height, { detailGain: 0.0 });
    expect(gainZero.pixels).toEqual(llOnly.pixels);
  });

  it('rejects truncated payload', () => {
    // Construct a minimal valid header with subtype 0x0300 pointing to truncated payload
    const buf = new Uint8Array(20);
    // "ITW_"
    buf[0] = 0x49; buf[1] = 0x54; buf[2] = 0x57; buf[3] = 0x5F;
    buf[4] = 0x01; buf[5] = 0x00; // version 0x0100
    buf[6] = 0; buf[7] = 10; buf[8] = 0; buf[9] = 10; // 10x10
    buf[0xA] = 0; buf[0xB] = 8; // bpp 8
    buf[0xC] = 0x03; buf[0xD] = 0x00; // subtype 0x0300
    // Payload: BE32 length = 9999 (way more than remaining 6 bytes)
    buf[14] = 0; buf[15] = 0; buf[16] = 0x27; buf[17] = 0x0F;
    expect(() => decode0300(buf, 14, 10, 10)).toThrow('wavelet payload overruns file');
  });
});
