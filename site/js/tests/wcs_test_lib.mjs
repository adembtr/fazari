// Shared helper for the Node tests: a byte source over a local file.
import { readFileSync } from "node:fs";

export function fileSource(path) {
  const buf = readFileSync(path);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    read: async (a, b) => u8.subarray(a, Math.min(b, u8.length)),
    readSuffix: async (n) => u8.subarray(Math.max(0, u8.length - n)),
  };
}
