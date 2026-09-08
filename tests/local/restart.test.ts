import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { localFixture } from "./helpers.js";

const OPTIONS = {
  defaultGitIdentity: { name: "Restart Test", email: "restart@example.test" },
  now: () => 1_577_836_800_000,
  timezoneOffset: () => 0,
};

describe("LocalWorkspace restart", () => {
  it("reopens a conflicted merge and restores its baseline on abort", async () => {
    const fixture = localFixture();
    let workspace = fixture.workspace(OPTIONS);
    try {
      await workspace.git.init();
      writeFileSync(join(fixture.root, "file.txt"), "base\n");
      await workspace.git.add({ paths: ["file.txt"] });
      await workspace.git.commit({ message: "base" });
      await workspace.git.branch({ name: "side", checkout: true });
      writeFileSync(join(fixture.root, "file.txt"), "side\n");
      await workspace.git.add({ paths: ["file.txt"] });
      await workspace.git.commit({ message: "side" });
      await workspace.git.checkout({ ref: "main" });
      writeFileSync(join(fixture.root, "file.txt"), "main\n");
      await workspace.git.add({ paths: ["file.txt"] });
      await workspace.git.commit({ message: "main" });
      expect(await workspace.git.merge({ theirs: "side", message: "merge side" })).toMatchObject({
        conflicted: true,
      });
      workspace.close();

      workspace = fixture.workspace(OPTIONS);
      await workspace.git.mergeAbort();
      expect(readFileSync(join(fixture.root, "file.txt"), "utf8")).toBe("main\n");
      expect(await workspace.git.status()).toEqual([]);
    } finally {
      workspace.close();
      fixture.dispose();
    }
  });
});
