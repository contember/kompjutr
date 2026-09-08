import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalWorkspace } from "@kompjutr/local";

const base = mkdtempSync(join(tmpdir(), "kompjutr-mount-witness-"));
const source = join(base, "source");
const mountedRoot = join(base, "mounted-root");
const stateDirectory = join(base, "state");
const recoveryDirectory = join(base, "recovery");
const stateAlias = join(base, "state-alias");
mkdirSync(source);
mkdirSync(mountedRoot);
mkdirSync(stateAlias);
execFileSync("mount", ["--bind", source, mountedRoot]);
try {
  writeFileSync(join(source, "tracked.txt"), "old");
  const workspace = new LocalWorkspace({ root: mountedRoot, stateDirectory, recoveryDirectory });
  try {
    workspace.database.run("CREATE TABLE marker (value TEXT NOT NULL)");
    let code: string | undefined;
    try {
      workspace.database.transactionSync(() => {
        workspace.drive.writeFile("/tracked.txt", new TextEncoder().encode("new"));
        workspace.database.run("INSERT INTO marker VALUES ('new')");
      });
    } catch (error) {
      if (typeof error === "object" && error !== null) {
        const value: unknown = Reflect.get(error, "code");
        if (typeof value === "string") code = value;
      }
    }
    if (code !== "EXDEV") throw new Error(`expected EXDEV, received ${code ?? "success"}`);
    if (readFileSync(join(source, "tracked.txt"), "utf8") !== "old") {
      throw new Error("bind-mount probe changed caller content");
    }
    if (workspace.database.scalar("SELECT COUNT(*) FROM marker") !== 0) {
      throw new Error("bind-mount probe committed database state");
    }
  } finally {
    workspace.close();
  }
  execFileSync("mount", ["--bind", source, stateAlias]);
  try {
    let code: string | undefined;
    try {
      new LocalWorkspace({
        root: mountedRoot,
        stateDirectory: stateAlias,
        recoveryDirectory,
      }).close();
    } catch (error) {
      if (typeof error === "object" && error !== null) {
        const value: unknown = Reflect.get(error, "code");
        if (typeof value === "string") code = value;
      }
    }
    if (code !== "EINVAL")
      throw new Error(`expected bind alias EINVAL, received ${code ?? "success"}`);
  } finally {
    execFileSync("umount", [stateAlias]);
  }
} finally {
  execFileSync("umount", [mountedRoot]);
  rmSync(base, { force: true, recursive: true });
}
