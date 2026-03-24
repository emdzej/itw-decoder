import { describe, it, expect } from 'vitest';
import { parseHeader, toBuffer, ITWError } from '../src/itw';

describe('toBuffer', () => {
  it('returns same Buffer if already a Buffer', () => {
    const buf = Buffer.from([1, 2, 3]);
    expect(toBuffer(buf)).toBe(buf);
  });

  it('wraps Uint8Array as Buffer', () => {
    const arr = new Uint8Array([0xAB, 0xCD]);
    const buf = toBuffer(arr);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.readUInt16BE(0)).toBe(0xABCD);
  });

  it('handles Uint8Array with offset', () => {
    const backing = new ArrayBuffer(8);
    new Uint8Array(backing)[4] = 0x42;
    const slice = new Uint8Array(backing, 4, 1);
    const buf = toBuffer(slice);
    expect(buf[0]).toBe(0x42);
    expect(buf.length).toBe(1);
  });
});

describe('parseHeader', () => {
  function makeHeader(opts: {
    magic?: string;
    version?: number;
    width?: number;
    height?: number;
    bpp?: number;
    subtype?: number;
  } = {}): Uint8Array {
    const buf = new Uint8Array(14);
    const magic = opts.magic ?? 'ITW_';
    buf[0] = magic.charCodeAt(0);
    buf[1] = magic.charCodeAt(1);
    buf[2] = magic.charCodeAt(2);
    buf[3] = magic.charCodeAt(3);
    const version = opts.version ?? 0x0100;
    buf[4] = (version >> 8) & 0xFF; buf[5] = version & 0xFF;
    const width = opts.width ?? 320;
    buf[6] = (width >> 8) & 0xFF; buf[7] = width & 0xFF;
    const height = opts.height ?? 240;
    buf[8] = (height >> 8) & 0xFF; buf[9] = height & 0xFF;
    const bpp = opts.bpp ?? 8;
    buf[0x0A] = (bpp >> 8) & 0xFF; buf[0x0B] = bpp & 0xFF;
    const subtype = opts.subtype ?? 0x0300;
    buf[0x0C] = (subtype >> 8) & 0xFF; buf[0x0D] = subtype & 0xFF;
    return buf;
  }

  it('parses a valid 0x0300 header', () => {
    const buf = makeHeader({ width: 316, height: 238, subtype: 0x0300, version: 0x0100 });
    const { header, payloadOffset } = parseHeader(buf);
    expect(header.width).toBe(316);
    expect(header.height).toBe(238);
    expect(header.subtype).toBe(0x0300);
    expect(header.version).toBe(0x0100);
    expect(header.bpp).toBe(8);
    expect(payloadOffset).toBe(14);
  });

  it('parses a valid 0x0400 header', () => {
    const buf = makeHeader({ subtype: 0x0400, version: 0x0200 });
    const { header } = parseHeader(buf);
    expect(header.subtype).toBe(0x0400);
  });

  it('rejects bad magic', () => {
    expect(() => parseHeader(makeHeader({ magic: 'JPEG' }))).toThrow('bad magic');
  });

  it('rejects unsupported version', () => {
    expect(() => parseHeader(makeHeader({ version: 0x0300 }))).toThrow('unsupported version');
  });

  it('rejects unsupported subtype', () => {
    expect(() => parseHeader(makeHeader({ subtype: 0x0500 }))).toThrow('unsupported subtype');
  });

  it('rejects unsupported bpp', () => {
    expect(() => parseHeader(makeHeader({ bpp: 24 }))).toThrow('unsupported bpp');
  });

  it('rejects too-small buffer', () => {
    expect(() => parseHeader(new Uint8Array(10))).toThrow('file too small');
  });
});
