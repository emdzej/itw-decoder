#!/usr/bin/env ts-node
/**
 * Bulk-test ITW decoder against the full GRAFIK corpus.
 * Decodes each file (no PNG output) and collects pass/fail stats.
 *
 * Usage: ./node_modules/.bin/ts-node bulk_test.ts [grafik_dir] [--limit N]
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { parseHeader, ITWError } from "./src/itw";
import { decode0300 } from "./src/decode0300";
import { decode0400 } from "./src/decode0400";

const GRAFIK_DIR = process.argv[2] || "/Volumes/emdzej/Documents/tis/GRAFIK";
const limitIdx = process.argv.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;

interface ErrorInfo { file: string; error: string; subtype?: string; }

const stats = {
  total: 0,
  ok0300: 0,
  ok0400: 0,
  headerFail: 0,
  decode0300Fail: 0,
  decode0400Fail: 0,
  errors: [] as ErrorInfo[],
  dimensions: new Map<string, number>(),
  versions: new Map<string, number>(),
};

function inc(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) || 0) + 1);
}

function processFile(file: string) {
  const rel = relative(GRAFIK_DIR, file);
  try {
    const buf = readFileSync(file);
    const { header, payloadOffset } = parseHeader(buf);

    inc(stats.dimensions, `${header.width}x${header.height}`);
    inc(stats.versions, `0x${header.version.toString(16).padStart(4, '0')}`);

    if (header.subtype === 0x0300) {
      const result = decode0300(buf, payloadOffset, header.width, header.height);
      if (result.pixels.length !== result.width * result.height) {
        throw new Error(`pixel size mismatch: ${result.pixels.length} != ${result.width * result.height}`);
      }
      stats.ok0300++;
    } else {
      const result = decode0400(buf, payloadOffset, header.width, header.height);
      if (result.pixels.length !== result.width * result.height) {
        throw new Error(`pixel size mismatch: ${result.pixels.length} != ${result.width * result.height}`);
      }
      stats.ok0400++;
    }
  } catch (err: any) {
    const msg = err.message || String(err);
    const isHeaderFail = msg.includes("bad magic") || msg.includes("unsupported version") ||
                         msg.includes("unsupported subtype") || msg.includes("file too small");
    if (isHeaderFail) {
      stats.headerFail++;
    } else {
      // Try to determine subtype
      let subtype = "unknown";
      try {
        const buf = readFileSync(file);
        const { header } = parseHeader(buf);
        subtype = `0x${header.subtype.toString(16).padStart(4, '0')}`;
        if (header.subtype === 0x0300) stats.decode0300Fail++;
        else stats.decode0400Fail++;
      } catch {
        stats.decode0300Fail++; // unknown
      }
    }
    if (stats.errors.length < 500) {
      stats.errors.push({ file: rel, error: msg.slice(0, 300) });
    }
  }
}

/** Walk directory tree, call callback on each .ITW file */
function walkDir(dir: string, callback: (file: string) => void): boolean {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return false; }
  for (const e of entries) {
    if (stats.total >= LIMIT) return true; // hit limit
    const full = join(dir, e);
    try {
      const s = statSync(full);
      if (s.isDirectory()) {
        if (walkDir(full, callback)) return true;
      } else if (e.toUpperCase().endsWith(".ITW")) {
        stats.total++;
        callback(full);
      }
    } catch { /* skip */ }
  }
  return false;
}

function main() {
  console.log(`Scanning ${GRAFIK_DIR} ...`);
  const startTime = Date.now();
  let lastReport = startTime;

  walkDir(GRAFIK_DIR, (file) => {
    processFile(file);

    const now = Date.now();
    if (now - lastReport > 5000) {
      const elapsed = (now - startTime) / 1000;
      const rate = stats.total / elapsed;
      console.log(
        `[${stats.total}] OK: ${stats.ok0300 + stats.ok0400} (0300:${stats.ok0300} 0400:${stats.ok0400}) ` +
        `FAIL: ${stats.headerFail + stats.decode0300Fail + stats.decode0400Fail} ` +
        `(${rate.toFixed(0)}/s)`
      );
      lastReport = now;
    }
  });

  const elapsed = (Date.now() - startTime) / 1000;

  console.log("\n========================================");
  console.log("  ITW BULK DECODER TEST RESULTS");
  console.log("========================================");
  console.log(`Total files:      ${stats.total}`);
  console.log(`Elapsed:          ${elapsed.toFixed(1)}s (${(stats.total / elapsed).toFixed(0)} files/s)`);
  console.log(`\n✅ Success:`);
  console.log(`  0x0300 wavelet: ${stats.ok0300}`);
  console.log(`  0x0400 entropy: ${stats.ok0400}`);
  console.log(`  Total OK:       ${stats.ok0300 + stats.ok0400}`);
  const totalFail = stats.headerFail + stats.decode0300Fail + stats.decode0400Fail;
  console.log(`\n❌ Failures:`);
  console.log(`  Header parse:   ${stats.headerFail}`);
  console.log(`  0x0300 decode:  ${stats.decode0300Fail}`);
  console.log(`  0x0400 decode:  ${stats.decode0400Fail}`);
  console.log(`  Total FAIL:     ${totalFail}`);

  const successRate = (stats.ok0300 + stats.ok0400) / stats.total * 100;
  console.log(`\n📊 Success rate: ${successRate.toFixed(2)}%`);

  // Dimension distribution
  const dims = [...stats.dimensions.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\nDimension distribution (top 20 of ${dims.length}):`);
  for (const [dim, count] of dims.slice(0, 20)) {
    console.log(`  ${dim.padEnd(12)} ${count}`);
  }
  if (dims.length > 20) console.log(`  ... and ${dims.length - 20} more sizes`);

  // Version distribution
  console.log(`\nVersion distribution:`);
  for (const [ver, count] of stats.versions.entries()) {
    console.log(`  ${ver}: ${count}`);
  }

  // Error summary
  if (stats.errors.length > 0) {
    const errorGroups = new Map<string, { count: number; examples: string[] }>();
    for (const { file, error } of stats.errors) {
      const key = error.slice(0, 100);
      const g = errorGroups.get(key) || { count: 0, examples: [] };
      g.count++;
      if (g.examples.length < 3) g.examples.push(file);
      errorGroups.set(key, g);
    }
    const sorted = [...errorGroups.entries()].sort((a, b) => b[1].count - a[1].count);
    console.log(`\nError categories (${sorted.length} types):`);
    for (const [err, { count, examples }] of sorted.slice(0, 30)) {
      console.log(`  [${count}x] ${err}`);
      for (const ex of examples) {
        console.log(`         e.g. ${ex}`);
      }
    }
  }
}

main();
