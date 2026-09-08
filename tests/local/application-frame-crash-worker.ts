import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  DiskDrive,
  NodeSqliteDatabase,
  ObservationClock,
  PathMapper,
  RecoveryCoordinator,
} from "@kompjutr/local";

const [root, stateDirectory, recoveryDirectory] = process.argv.slice(2);
if (root === undefined || stateDirectory === undefined || recoveryDirectory === undefined) {
  throw new Error("application frame crash worker arguments are missing");
}

mkdirSync(stateDirectory, { recursive: true });
mkdirSync(recoveryDirectory, { recursive: true });
const spillDirectory = join(stateDirectory, "spills");
mkdirSync(spillDirectory);
const mapper = new PathMapper(root);
let frames = 0;
const recovery = new RecoveryCoordinator(mapper, recoveryDirectory, {
  journalFrameBytes: 230,
  checkpoint(checkpoint) {
    if (checkpoint === "application-frame-synced" && ++frames === 1) {
      process.kill(process.pid, "SIGKILL");
    }
  },
});
const database = new NodeSqliteDatabase(join(stateDirectory, "state.sqlite"), {
  mutationScope: recovery,
  recovery,
  root,
  recoveryDirectory,
});
const drive = new DiskDrive({
  root,
  spillDirectory,
  mutationScope: recovery,
  observations: new ObservationClock(database),
  recovery,
});
const bytes = new TextEncoder().encode("new");
database.transactionSync(() => {
  drive.writeFiles(
    Array.from({ length: 6 }, (_, index) => ({
      path: `/tracked-${index}-${"x".repeat(80)}`,
      bytes,
    })),
  );
});
throw new Error("application intent did not split before mutation");
