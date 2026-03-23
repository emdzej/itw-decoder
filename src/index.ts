#!/usr/bin/env node
import { readFileSync } from "fs";
import { basename, resolve } from "path";
import { ITWError, parseHeader } from "./itw";
import { decode0400 } from "./decode0400";
import { decode0300 } from "./decode0300";
import { writePng } from "./png";

function usage(): never {
  console.error("Usage: itw-decode <input.itw> [-o output.png]");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) usage();
  const input = resolve(args[0]);
  let output: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-o" && i + 1 < args.length) {
      output = resolve(args[i + 1]);
      i++;
    }
  }

  const buf = readFileSync(input);
  const { header, payloadOffset } = parseHeader(buf);
  let result;
  if (header.subtype === 0x0300) {
    result = decode0300(buf, payloadOffset, header.width, header.height);
  } else {
    result = decode0400(buf, payloadOffset, header.width, header.height);
  }

  const outPath = output ?? resolve(process.cwd(), `${basename(input).replace(/\.itw$/i, "")}.png`);
  await writePng(outPath, result.pixels, result.width, result.height);
  console.error(`wrote ${outPath} (${result.width}x${result.height})`);
}

main().catch((err) => {
  if (err instanceof ITWError) {
    console.error(`error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
