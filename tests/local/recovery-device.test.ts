import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  DiskDrive,
  LocalWorkspace,
  NodeSqliteDatabase,
  ObservationClock,
  PathMapper,
  RecoveryCoordinator,
} from "@kompjutr/local";
import { describe, expect, it } from "vitest";
import { localFixture } from "./helpers.js";

const encoder = new TextEncoder();

describe("local recovery device qualification", () => {
  it("rejects a failed live rename probe before application or database effects", () => {
    const fixture = localFixture();
    mkdirSync(fixture.state);
    mkdirSync(fixture.recovery);
    mkdirSync(join(fixture.state, "spills"));
    writeFileSync(join(fixture.root, "tracked.txt"), "old");
    const mapper = new PathMapper(fixture.root);
    const recovery = new RecoveryCoordinator(mapper, fixture.recovery, {
      probeRename() {
        throw Object.assign(new Error("simulated bind-mount boundary"), { code: "EXDEV" });
      },
    });
    const database = new NodeSqliteDatabase(join(fixture.state, "state.sqlite"), {
      mutationScope: recovery,
      recovery,
    });
    const drive = new DiskDrive({
      root: fixture.root,
      spillDirectory: join(fixture.state, "spills"),
      mutationScope: recovery,
      observations: new ObservationClock(database),
      recovery,
    });
    try {
      database.run("CREATE TABLE marker (value TEXT NOT NULL)");
      expect(() =>
        database.transactionSync(() => {
          drive.writeFile("/tracked.txt", encoder.encode("new"));
          database.run("INSERT INTO marker VALUES ('new')");
        }),
      ).toThrowError(expect.objectContaining({ code: "EXDEV" }));
      expect(readFileSync(join(fixture.root, "tracked.txt"), "utf8")).toBe("old");
      expect(database.scalar("SELECT COUNT(*) FROM marker")).toBe(0);
    } finally {
      drive.close();
      database.close();
      fixture.dispose();
    }
  });

  it.skipIf(!existsSync("/dev/shm"))(
    "rejects a real different-device recovery directory without caller effects",
    () => {
      const fixture = localFixture();
      const recovery = mkdtempSync("/dev/shm/kompjutr-recovery-test-");
      if (lstatSync(recovery).dev === lstatSync(fixture.root).dev) {
        rmSync(recovery, { recursive: true });
        fixture.dispose();
        return;
      }
      writeFileSync(join(fixture.root, "tracked.txt"), "old");
      const crossDevice = new LocalWorkspace({
        root: fixture.root,
        stateDirectory: fixture.state,
        recoveryDirectory: recovery,
      });
      try {
        expect(() =>
          crossDevice.database.transactionSync(() =>
            crossDevice.drive.writeFile("/tracked.txt", encoder.encode("new")),
          ),
        ).toThrowError(expect.objectContaining({ code: "EXDEV" }));
        expect(readFileSync(join(fixture.root, "tracked.txt"), "utf8")).toBe("old");
      } finally {
        crossDevice.close();
        rmSync(recovery, { force: true, recursive: true });
        fixture.dispose();
      }
    },
  );
});
