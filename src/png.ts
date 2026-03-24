/**
 * Copyright (c) 2026 Michał Jaskólski
 *
 * This source code is licensed under the PolyForm Noncommercial License 1.0.0
 * found in the LICENSE file in the root directory of this repository.
 * https://polyformproject.org/licenses/noncommercial/1.0.0
 */

import { PNG } from "pngjs";
import { createWriteStream } from "fs";

export function grayToRgba(gray: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    const v = gray[i];
    out[j] = v;
    out[j + 1] = v;
    out[j + 2] = v;
    out[j + 3] = 255;
  }
  return out;
}

export async function writePng(path: string, gray: Uint8Array, width: number, height: number): Promise<void> {
  const png = new PNG({ width, height, colorType: 6 });
  png.data = Buffer.from(grayToRgba(gray, width, height));
  await new Promise<void>((resolve, reject) => {
    png
      .pack()
      .pipe(createWriteStream(path))
      .on("finish", () => resolve())
      .on("error", reject);
  });
}
