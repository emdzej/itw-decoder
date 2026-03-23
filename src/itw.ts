export type ITWSubtype = 0x0300 | 0x0400;

export interface ITWHeader {
  version: number;
  width: number;
  height: number;
  bpp: number;
  subtype: ITWSubtype;
}

export class ITWError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ITWError";
  }
}

export function readBE16(buf: Uint8Array, off: number): number {
  if (off + 2 > buf.length) throw new ITWError(`readBE16 out of range @${off}`);
  return (buf[off] << 8) | buf[off + 1];
}

export function readBE32From2BE16(buf: Uint8Array, off: number): number {
  const hi = readBE16(buf, off);
  const lo = readBE16(buf, off + 2);
  return (hi << 16) | lo;
}

export function readLE32(buf: Uint8Array, off: number): number {
  if (off + 4 > buf.length) throw new ITWError(`readLE32 out of range @${off}`);
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
}

export function parseHeader(buf: Uint8Array): { header: ITWHeader; payloadOffset: number } {
  // Header layout (from Ghidra FUN_004b5680 + FUN_004b5780):
  //   6 x BE16 in FUN_004b5680: magic(2), magic(2), version, width, height, bpp
  //   1 x BE16 in FUN_004b5780: subtype
  // Total = 7 x BE16 = 14 bytes
  if (buf.length < 14) throw new ITWError("file too small for header");
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
  if (magic !== "ITW_") throw new ITWError("bad magic");
  const version = readBE16(buf, 4);
  const width = readBE16(buf, 6);
  const height = readBE16(buf, 8);
  const bpp = readBE16(buf, 0x0a);
  const subtype = readBE16(buf, 0x0c) as ITWSubtype;
  if (version !== 0x0100 && version !== 0x0200) throw new ITWError(`unsupported version 0x${version.toString(16)}`);
  if (subtype !== 0x0300 && subtype !== 0x0400) throw new ITWError(`unsupported subtype 0x${(subtype as number).toString(16)}`);
  if (bpp !== 8) throw new ITWError(`unsupported bpp ${bpp}`);
  return { header: { version, width, height, bpp, subtype }, payloadOffset: 14 };
}

export interface DecodeResult {
  width: number;
  height: number;
  pixels: Uint8Array; // grayscale bytes length = width*height
}
