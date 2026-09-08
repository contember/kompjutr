import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
for (const name of ["sqlite", "drive", "git", "do", "local"]) {
  const target = resolve(root, "packages", name, "dist");
  const expectedParent = resolve(root, "packages", name);
  if (dirname(target) !== expectedParent) throw new Error(`Refusing to clean ${target}`);
  await rm(target, { force: true, recursive: true });
  await rm(resolve(root, `${name}.tsbuildinfo`), { force: true });
}
