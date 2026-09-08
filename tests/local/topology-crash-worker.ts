import { LocalWorkspace, type RecoveryCheckpoint } from "@kompjutr/local";

const [root, stateDirectory, recoveryDirectory, expectedCheckpoint] = process.argv.slice(2);
if (
  root === undefined ||
  stateDirectory === undefined ||
  recoveryDirectory === undefined ||
  expectedCheckpoint === undefined
) {
  throw new Error("topology crash worker arguments are missing");
}

let armed = false;
const workspace = new LocalWorkspace({
  root,
  stateDirectory,
  recoveryDirectory,
  recoveryCheckpoint(checkpoint: RecoveryCheckpoint) {
    if (armed && checkpoint === expectedCheckpoint) process.kill(process.pid, "SIGKILL");
  },
});
workspace.database.run("CREATE TABLE IF NOT EXISTS topology_marker (value TEXT NOT NULL)");
armed = true;
workspace.database.transactionSync(() => {
  workspace.drive.writeFile("/a/file", new TextEncoder().encode("new"));
  workspace.drive.removeFiles(["/a"], { recursive: true });
  workspace.drive.symlink("target", "/a");
  workspace.database.run("INSERT INTO topology_marker VALUES ('committed')");
});
throw new Error(`checkpoint was not reached: ${expectedCheckpoint}`);
