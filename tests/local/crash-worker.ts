import { LocalWorkspace, type RecoveryCheckpoint } from "@kompjutr/local";

const [
  root,
  stateDirectory,
  recoveryDirectory,
  expectedCheckpoint,
  targetPath = "/tracked.txt",
  mutation = "write",
] = process.argv.slice(2);
if (
  root === undefined ||
  stateDirectory === undefined ||
  recoveryDirectory === undefined ||
  expectedCheckpoint === undefined
) {
  throw new Error("crash worker arguments are missing");
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
armed = true;

workspace.database.run("CREATE TABLE IF NOT EXISTS crash_marker (value TEXT NOT NULL)");
workspace.database.transactionSync(() => {
  if (mutation === "delete") {
    workspace.drive.unlink(targetPath);
    workspace.database.run("INSERT INTO crash_marker VALUES ('committed')");
    return;
  }
  workspace.drive.writeFile(targetPath, new TextEncoder().encode("new"));
  workspace.drive.writeFile("/created.txt", new TextEncoder().encode("created"));
  workspace.drive.createFile("/created-directory/entry.txt", 0o644);
  workspace.drive.writeRange("/created-directory/entry.txt", new TextEncoder().encode("nested"), 0);
  workspace.database.run("INSERT INTO crash_marker VALUES ('committed')");
});
throw new Error(`checkpoint was not reached: ${expectedCheckpoint}`);
