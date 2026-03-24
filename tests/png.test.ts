import { describe, it, expect } from 'vitest';
import { grayToRgba } from '../src/png';

describe('grayToRgba', () => {
  it('converts single pixel', () => {
    const gray = new Uint8Array([128]);
    const rgba = grayToRgba(gray, 1, 1);
    expect(rgba).toEqual(new Uint8Array([128, 128, 128, 255]));
  });

  it('converts black and white pixels', () => {
    const gray = new Uint8Array([0, 255]);
    const rgba = grayToRgba(gray, 2, 1);
    expect(rgba).toEqual(new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]));
  });

  it('output length is 4× input', () => {
    const gray = new Uint8Array(100);
    const rgba = grayToRgba(gray, 10, 10);
    expect(rgba.length).toBe(400);
  });

  it('alpha channel is always 255', () => {
    const gray = new Uint8Array([0, 50, 100, 150, 200, 250]);
    const rgba = grayToRgba(gray, 3, 2);
    for (let i = 3; i < rgba.length; i += 4) {
      expect(rgba[i]).toBe(255);
    }
  });

  it('R=G=B for each pixel', () => {
    const gray = new Uint8Array([42, 99, 200]);
    const rgba = grayToRgba(gray, 3, 1);
    for (let i = 0; i < 3; i++) {
      const off = i * 4;
      expect(rgba[off]).toBe(gray[i]);
      expect(rgba[off + 1]).toBe(gray[i]);
      expect(rgba[off + 2]).toBe(gray[i]);
    }
  });
});
