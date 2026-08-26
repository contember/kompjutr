import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const target = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const expected = resolve(root, "dist");

if (target !== expected || dirname(target) !== root || basename(target) !== "dist") {
  throw new Error(`Refusing to clean unexpected build output: ${target}`);
}

await rm(target, { force: true, recursive: true });
