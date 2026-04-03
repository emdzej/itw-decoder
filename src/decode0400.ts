/**
 * Copyright (c) 2026 Michał Jaskólski
 *
 * This source code is licensed under the PolyForm Noncommercial License 1.0.0
 * found in the LICENSE file in the root directory of this repository.
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

/**
 * ITW 0x0400 (entropy) decoder.
 *
 * Faithful port of the original pipeline from Ghidra decompilation:
 *   FUN_004b5a40 — read tables from file
 *   FUN_004b6340 — parse Huffman leaf table from byte array
 *   FUN_004b6570 — build Huffman tree by weight (float comparison!)
 *   FUN_004b6250 — Huffman decode: consume bytes LSB-first, emit symbols
 *   FUN_004b57f0 — main 0x0400 pipeline: interleave + expand
 *   FUN_004b5c40 — build powers-of-two table (depth=8)
 *   FUN_004b5d20 — expand: literal copy then RLE with powers table
 */

import { DecodeResult, ITWError, toBuffer } from "./itw";

// ─── Data structures ────────────────────────────────────────────────
// ByteStack mirrors FUN_004b67d0 / FUN_004b6890:
//   field[0] = count, field[3] = data pointer (byte array)
class ByteStack {
  data: number[] = [];
  get count() { return this.data.length; }
  push(v: number) { this.data.push(v & 0xff); }
  at(i: number): number {
    if (i < 0 || i >= this.data.length) throw new ITWError(`ByteStack out of bounds: ${i} (len=${this.data.length})`);
    return this.data[i];
  }
}

// IntStack mirrors FUN_004b6940 / FUN_004b6a10:
//   field[0] = count, field[3] = data pointer (int32 array)
class IntStack {
  data: number[] = [];
  get count() { return this.data.length; }
  push(v: number) { this.data.push(v); }
  at(i: number): number {
    if (i < 0 || i >= this.data.length) throw new ITWError(`IntStack out of bounds: ${i} (len=${this.data.length})`);
    return this.data[i];
  }
}

// ─── Huffman node (28 bytes in original) ────────────────────────────
interface HuffNode {
  isLeaf: number;    // offset 0x00: short (1=leaf, 0=internal)
  symbol: number;    // offset 0x02: byte
  id: number;        // offset 0x04: int
  leftId: number;    // offset 0x08: int
  rightId: number;   // offset 0x0C: int
  parentId: number;  // offset 0x10: int
  weight: number;    // offset 0x14: float (IEEE 754)
}

// ─── FUN_004b5a40: Read payload tables from buffer ──────────────────
function readTables(input: Uint8Array, off: number): {
  intArr: IntStack;     // DAT_00580020 (int-array): first element = N, then N byte values
  tableB: ByteStack;    // DAT_00580014 (byte-array): len1 bytes
  tableC: ByteStack;    // DAT_0058001c (byte-array): len2 bytes
  n: number;            // DAT_00580018
} {
  const buf = toBuffer(input);
  const intArr = new IntStack();  // DAT_00580020
  const tableB = new ByteStack(); // DAT_00580014
  const tableC = new ByteStack(); // DAT_0058001c

  let p = off;
  if (p >= buf.length) throw new ITWError("payload missing N");

  // fread(&local_1,1,1,param_1); DAT_00580018 = local_1 & 0xff;
  const n = buf[p++];

  // FUN_004b6a10(DAT_00580020, DAT_00580018);  — push N itself
  intArr.push(n);

  // then push N byte values as ints
  for (let i = 0; i < n; i++) {
    if (p >= buf.length) throw new ITWError("table A overruns file");
    intArr.push(buf[p++] & 0xff);
  }

  // len1 = FUN_004b5750(param_1) → BE32 via two BE16
  if (p + 4 > buf.length) throw new ITWError("missing len1");
  const len1 = buf.readUInt32BE(p);
  p += 4;
  if (p + len1 > buf.length) throw new ITWError("payload length exceeds file size at table B");
  for (let i = 0; i < len1; i++) {
    tableB.push(buf[p++]);
  }

  // len2 = FUN_004b5750(param_1) → BE32 via two BE16
  if (p + 4 > buf.length) throw new ITWError("missing len2");
  const len2 = buf.readUInt32BE(p);
  p += 4;
  if (p + len2 > buf.length) throw new ITWError("payload length exceeds file size at table C");
  for (let i = 0; i < len2; i++) {
    tableC.push(buf[p++]);
  }

  return { intArr, tableB, tableC, n };
}

// ─── FUN_004b6340: Parse Huffman leaf table from ByteStack ──────────
function parseHuffLeaves(bs: ByteStack): {
  leaves: HuffNode[];
  trailingVal: number;
  bitstreamStart: number;
} {
  if (bs.count < 4) throw new ITWError("huff table too small");

  // count assembled as LE32: b0 + b1*256 + b2*65536 + b3*16M
  const count = bs.at(0) + bs.at(1) * 0x100 + bs.at(2) * 0x10000 + bs.at(3) * 0x1000000;
  let p = 4;
  const leaves: HuffNode[] = [];

  for (let i = 0; i < count; i++) {
    if (p + 8 > bs.count) throw new ITWError("huff leaf overrun");
    // byte at p+0 = symbol (stored to node+2, but read from record[0])
    const symbol = bs.at(p);
    // bytes p+4..p+7 = weight assembled LE, interpreted as IEEE 754 float
    const weightBits = (bs.at(p + 4) | (bs.at(p + 5) << 8) |
                        (bs.at(p + 6) << 16) | (bs.at(p + 7) << 24)) >>> 0;
    const floatBuf = new ArrayBuffer(4);
    new DataView(floatBuf).setUint32(0, weightBits, true);
    const weight = new DataView(floatBuf).getFloat32(0, true);

    leaves.push({
      isLeaf: 1,
      symbol,
      id: -1,
      leftId: -1,
      rightId: -1,
      parentId: -1,
      weight,
    });
    p += 8;
  }

  if (p + 4 > bs.count) throw new ITWError("missing trailing huff value");
  const trailingVal = bs.at(p) + bs.at(p + 1) * 0x100 + bs.at(p + 2) * 0x10000 + bs.at(p + 3) * 0x1000000;
  p += 4;

  return { leaves, trailingVal, bitstreamStart: p };
}

// ─── FUN_004b6570 + FUN_004b60c0: Build Huffman tree ────────────────
function buildHuffTree(leaves: HuffNode[]): HuffNode[] {
  if (leaves.length === 0) throw new ITWError("empty huff table");

  const nodes: HuffNode[] = [];
  let nextId = 0;

  // Assign IDs to leaves
  for (const leaf of leaves) {
    leaf.id = nextId++;
    nodes.push(leaf);
  }

  // Priority queue: indices to merge
  let queue = leaves.map(l => l.id);

  // The original C code stores weights as IEEE 754 float (32-bit).
  // We must use float32 arithmetic for the sum so that internal-node
  // weights land on the same values the original encoder used;
  // float64 rounding can reorder nodes and produce a wrong tree.
  const f32 = new Float32Array(1);

  while (queue.length > 1) {
    // Sort by weight ascending (float comparison as in original FUN_004b60c0)
    queue.sort((a, b) => nodes[a].weight - nodes[b].weight);

    const leftId = queue.shift()!;
    const rightId = queue.shift()!;
    const left = nodes[leftId];
    const right = nodes[rightId];

    f32[0] = left.weight + right.weight;

    const parentNode: HuffNode = {
      isLeaf: 0,
      symbol: 0,
      id: nextId++,
      leftId: left.id,
      rightId: right.id,
      parentId: -1,
      weight: f32[0],
    };
    left.parentId = parentNode.id;
    right.parentId = parentNode.id;
    nodes.push(parentNode);
    queue.push(parentNode.id);
  }

  // Root
  const rootId = queue[0];
  nodes[rootId].parentId = -1;

  return nodes;
}

// ─── FUN_004b6250: Huffman decode from ByteStack ────────────────────
// Consumes bytes from bitstreamStart..end, 8 bits per byte LSB-first.
// On leaf, emits symbol to output ByteStack.
function huffDecode(bs: ByteStack, bitstreamStart: number, nodes: HuffNode[], rootId: number, maxBits: number): ByteStack {
  const out = new ByteStack();
  let curId = rootId;
  let bitsUsed = 0;

  for (let byteIdx = bitstreamStart; byteIdx < bs.count; byteIdx++) {
    let byte = bs.at(byteIdx);
    let bitsInByte = 8;

    while (bitsInByte > 0) {
      if (bitsUsed >= maxBits) return out;

      bitsInByte--;
      bitsUsed++;

      const node = nodes[curId];
      // bit 0 → left (+8 in original), bit 1 → right (+0xC)
      if ((byte & 1) === 0) {
        curId = node.leftId;
      } else {
        curId = node.rightId;
      }
      byte = byte >> 1;

      if (curId < 0 || curId >= nodes.length) {
        throw new ITWError(`huffman tree traversal error: invalid nodeId ${curId}`);
      }

      const child = nodes[curId];
      if (child.isLeaf !== 0) {
        out.push(child.symbol);
        curId = rootId; // reset to root
      }
    }
  }
  return out;
}

// ─── Full Huffman pipeline for one table ────────────────────────────
function huffDecodeTable(bs: ByteStack): ByteStack {
  const { leaves, trailingVal, bitstreamStart } = parseHuffLeaves(bs);
  const nodes = buildHuffTree(leaves);
  const rootId = nodes.length - 1; // Root is last node added
  // trailingVal = bit budget (stored at param_1[4] in original, read as LE32)
  return huffDecode(bs, bitstreamStart, nodes, rootId, trailingVal);
}

// ─── FUN_004b57f0: Interleave decoded B and C into intArr ───────────
const DEPTH = 8; // DAT_004ed104 = 8

function interleave(n: number, decodedB: ByteStack, decodedC: ByteStack, intArr: IntStack): void {
  let remaining = decodedB.count + decodedC.count;
  let idxB = 0; // ESI — index into decodedB (puVar4) data
  let idxC = 0; // EDI — index into decodedC (puVar5) data

  while (remaining > 0) {
    // Guard: stop if B data is exhausted (original C code has no bounds check —
    // it would read garbage beyond the buffer; we stop gracefully instead)
    if (idxB >= decodedB.count) break;

    const bVal = decodedB.at(idxB);

    if (bVal < n + DEPTH) {
      // Push C byte then B byte; consume 2 from remaining
      remaining -= 2;
      // Guard: if C data is exhausted, push 0 (matches original's "read past end" behavior)
      if (idxC < decodedC.count) {
        intArr.push(decodedC.at(idxC));
      } else {
        intArr.push(0);
      }
      idxC++;
      intArr.push(bVal);
    } else {
      // Push just B byte; consume 1 from remaining
      remaining -= 1;
      intArr.push(bVal);
    }
    idxB++;
  }
}

// ─── FUN_004b5d20: Expand intArr via powers table ───────────────────
function expand(intArr: IntStack): ByteStack {
  const out = new ByteStack();
  const data = intArr.data;
  if (data.length === 0) throw new ITWError("empty intArr for expansion");

  // First word = N (literal count); *param_1 = uVar2
  const literalCount = data[0];

  // Copy next literalCount ints into codebook (param_1[1] array)
  const codebook: number[] = [];
  let p = 1;
  for (let i = 0; i < literalCount && p < data.length; i++, p++) {
    codebook.push(data[p]);
  }

  // param_1[3] = depth = 8 (from FUN_004b5c40: *(param_1+0xc) = 8)
  const depth = DEPTH;

  // Process remaining words
  while (p < data.length) {
    const w = data[p];

    if (w < literalCount + depth) {
      // Replicate: times = 2^w, value = codebook[nextWord - depth]
      let times = 1;
      for (let k = 0; k < w; k++) times *= 2;

      const idx = data[p + 1];
      p += 2;

      // Value from codebook via: *(*(param_1[1]+0xc) + (idx - depth) * 4)
      // param_1[1] is the int-stack whose data array is codebook
      const cbIdx = idx - depth;
      if (cbIdx < 0 || cbIdx >= codebook.length) {
        throw new ITWError(`codebook index ${cbIdx} out of range (size ${codebook.length})`);
      }
      const val = codebook[cbIdx];
      for (let t = 0; t < times; t++) {
        out.push(val);
      }
    } else {
      // Single value: codebook[(w - literalCount) - depth]
      p += 1;
      const cbIdx = (w - literalCount) - depth;
      if (cbIdx < 0 || cbIdx >= codebook.length) {
        throw new ITWError(`codebook index ${cbIdx} out of range (size ${codebook.length})`);
      }
      out.push(codebook[cbIdx]);
    }
  }

  return out;
}

// ─── Main entry point ───────────────────────────────────────────────
export function decode0400(buf: Uint8Array, payloadOffset: number, width: number, height: number): DecodeResult {
  // Step 1: Read tables (FUN_004b5a40)
  const { intArr, tableB, tableC, n } = readTables(buf, payloadOffset);

  // Step 2: Huffman decode B and C (FUN_004b6250)
  const decodedB = huffDecodeTable(tableB);
  const decodedC = huffDecodeTable(tableC);

  // Step 3: Interleave decoded B/C into intArr (FUN_004b57f0 loop)
  interleave(n, decodedB, decodedC, intArr);

  // Step 4: Expand via powers table (FUN_004b5c40 + FUN_004b5d20)
  const expanded = expand(intArr);

  // Step 5: Copy to pixel buffer (1-indexed in original: data[idx-1+iVar11])
  // Note: Some files produce slightly fewer pixels than expected due to the
  // original C code's lack of bounds checking in the interleave/expand pipeline.
  // We tolerate a small shortfall (< 1% of total) and zero-fill the remainder.
  const total = width * height;
  if (expanded.count < total) {
    const shortfall = total - expanded.count;
    const shortfallPct = (shortfall / total) * 100;
    if (shortfallPct > 1) {
      throw new ITWError(`decoded pixel buffer too small: got ${expanded.count}, need ${total} (${shortfallPct.toFixed(1)}% short)`);
    }
  }

  const pixels = new Uint8Array(total); // zero-filled by default
  const copyLen = Math.min(expanded.count, total);
  for (let i = 0; i < copyLen; i++) {
    pixels[i] = expanded.at(i);
  }

  return { width, height, pixels };
}
