#!/usr/bin/env node
/**
 * Copyright (c) 2026 Michał Jaskólski
 *
 * This source code is licensed under the PolyForm Noncommercial License 1.0.0
 * found in the LICENSE file in the root directory of this repository.
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

import { readFileSync } from "fs";
import { basename, resolve, join } from "path";
import { Command } from "commander";
import { ITWError, parseHeader } from "./itw";
import { decode0400 } from "./decode0400";
import { decode0300 } from "./decode0300";
import { writePng } from "./png";

import { createRequire } from "module";
// resolve package.json relative to this file at runtime (works for both ts-node and compiled dist/)
const _require = createRequire(__filename);
const { version } = _require("../package.json") as { version: string };

const program = new Command();

program
  .name("itw-decode")
  .description("Decode BMW TIS .ITW proprietary image files to PNG")
  .version(version, "-V, --version", "output the current version")
  .argument("<input>", "path to the .ITW file to decode")
  .option("-o, --output <file>", "output PNG path (default: <input>.png)")
  .option("-d, --dir <directory>", "output directory (default: current working directory)")
  .action(async (input: string, options: { output?: string; dir?: string }) => {
    const inputPath = resolve(input);
    const defaultName = basename(inputPath).replace(/\.itw$/i, "") + ".png";
    const outputPath = options.output
      ? resolve(options.output)
      : join(resolve(options.dir ?? process.cwd()), defaultName);

    const buf = readFileSync(inputPath);
    const { header, payloadOffset } = parseHeader(buf);

    let result;
    if (header.subtype === 0x0300) {
      result = decode0300(buf, payloadOffset, header.width, header.height);
    } else {
      result = decode0400(buf, payloadOffset, header.width, header.height);
    }

    await writePng(outputPath, result.pixels, result.width, result.height);
    console.error(`wrote ${outputPath} (${result.width}x${result.height})`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof ITWError) {
    console.error(`error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
