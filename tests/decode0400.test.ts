import { describe, it, expect } from 'vitest';
import { decode0400 } from '../src/decode0400';
import { parseHeader } from '../src/itw';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

function findSample0400(): string | null {
  // Look for 0x0400 samples in common locations
  const dirs = [
    join(__dirname, '..', 'samples', '10', '00'),
    join(__dirname, '..', 'samples'),
  ];
  for (const dir of dirs) {
    try {
      const files = readdirSync(dir).filter(f => f.endsWith('.ITW'));
      for (const f of files) {
        const path = join(dir, f);
        try {
          const buf = readFileSync(path);
          const { header } = parseHeader(buf);
          if (header.subtype === 0x0400) return path;
        } catch { /* skip */ }
      }
    } catch { /* dir doesn't exist */ }
  }
  return null;
}

describe('decode0400', () => {
  it('rejects empty payload', () => {
    // Create a valid header pointing to empty payload
    const buf = new Uint8Array(14);
    // "ITW_"
    buf[0] = 0x49; buf[1] = 0x54; buf[2] = 0x57; buf[3] = 0x5F;
    // version 0x0200
    buf[4] = 0x02; buf[5] = 0x00;
    // width 10, height 10
    buf[6] = 0; buf[7] = 10; buf[8] = 0; buf[9] = 10;
    // bpp 8
    buf[0xA] = 0; buf[0xB] = 8;
    // subtype 0x0400
    buf[0xC] = 0x04; buf[0xD] = 0x00;

    expect(() => decode0400(buf, 14, 10, 10)).toThrow();
  });

  const samplePath = findSample0400();

  it.skipIf(!samplePath)('decodes a 0x0400 sample file', () => {
    const buf = readFileSync(samplePath!);
    const { header, payloadOffset } = parseHeader(buf);
    const result = decode0400(buf, payloadOffset, header.width, header.height);

    expect(result.width).toBe(header.width);
    expect(result.height).toBe(header.height);
    expect(result.pixels.length).toBe(header.width * header.height);

    // All pixel values should be valid bytes
    for (let i = 0; i < result.pixels.length; i++) {
      expect(result.pixels[i]).toBeGreaterThanOrEqual(0);
      expect(result.pixels[i]).toBeLessThanOrEqual(255);
    }
  });

  it.skipIf(!samplePath)('output is deterministic', () => {
    const buf = readFileSync(samplePath!);
    const { header, payloadOffset } = parseHeader(buf);
    const r1 = decode0400(buf, payloadOffset, header.width, header.height);
    const r2 = decode0400(buf, payloadOffset, header.width, header.height);
    expect(r1.pixels).toEqual(r2.pixels);
  });
});
