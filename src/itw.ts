/**
 * Copyright (c) 2026 Michał Jaskólski
 *
 * This source code is licensed under the PolyForm Noncommercial License 1.0.0
 * found in the LICENSE file in the root directory of this repository.
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

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

/** Ensure we have a Buffer (wraps plain Uint8Array if needed). */
export function toBuffer(buf: Uint8Array): Buffer {
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function parseHeader(input: Uint8Array): { header: ITWHeader; payloadOffset: number } {
  if (input.length < 14) throw new ITWError("file too small for header");
  const buf = toBuffer(input);
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== "ITW_") throw new ITWError("bad magic");
  const version = buf.readUInt16BE(4);
  const width = buf.readUInt16BE(6);
  const height = buf.readUInt16BE(8);
  const bpp = buf.readUInt16BE(0x0a);
  const subtype = buf.readUInt16BE(0x0c) as ITWSubtype;
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
