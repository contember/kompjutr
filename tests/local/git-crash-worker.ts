import { LocalWorkspace, type RecoveryCheckpoint } from "@kompjutr/local";

const [root, stateDirectory, recoveryDirectory, expectedCheckpoint, ref] = process.argv.slice(2);
if (
  root === undefined ||
  stateDirectory === undefined ||
  recoveryDirectory === undefined ||
  expectedCheckpoint === undefined ||
  ref === undefined
) {
  throw new Error("Git crash worker arguments are missing");
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
await workspace.git.checkout({ ref, force: true });
throw new Error(`checkpoint was not reached: ${expectedCheckpoint}`);
