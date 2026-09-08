import { LocalWorkspace, type RecoveryCheckpoint } from "@kompjutr/local";

const [root, stateDirectory, recoveryDirectory, expectedCheckpoint] = process.argv.slice(2);
if (
  root === undefined ||
  stateDirectory === undefined ||
  recoveryDirectory === undefined ||
  expectedCheckpoint === undefined
) {
  throw new Error("recovery kill worker arguments are missing");
}

new LocalWorkspace({
  root,
  stateDirectory,
  recoveryDirectory,
  recoveryCheckpoint(checkpoint: RecoveryCheckpoint) {
    if (checkpoint === expectedCheckpoint) process.kill(process.pid, "SIGKILL");
  },
});
throw new Error(`recovery checkpoint was not reached: ${expectedCheckpoint}`);
