import { Workspace } from "@cloudflare/computer";
import { describe, expect, it } from "vitest";

import { createSqliteGitClient } from "../src/compat/computer.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { SqliteTestStorage } from "./helpers/storage.js";

describe("Computer client operation interlocks", () => {
  it("blocks commit during replay and clears any operation on hard reset", async () => {
    const storage = new SqliteTestStorage();
    const workspace = new Workspace({
      storage,
      git: createSqliteGitClient({ now: () => 1_600_000_000_000 }),
      defaultGitIdentity: { name: "Agent", email: "agent@example.com" },
    });
    await workspace.git.init({});
    await workspace.fs.writeFile("/file.txt", "base\n");
    await workspace.git.add({ paths: ["file.txt"] });
    const original = await workspace.git.commit({ message: "base" });
    const database = new SqliteGitDatabase(new TestDatabase(storage));
    const repository = database.find("/");
    if (repository === null) throw new Error("repository is missing");
    const store = database.open(repository);
    store.writeOperationState(
      {
        kind: "revert",
        originalHeadRef: "refs/heads/main",
        originalHeadOid: original.oid,
        phase: "empty",
        emptyReason: "source",
        sourceOid: original.oid,
        selectedParentOid: null,
        mainline: null,
        currentLabel: "HEAD",
        incomingLabel: original.oid.slice(0, 7),
        message: "Revert base\n",
        author: null,
        committer: null,
      },
      [],
    );

    await expect(workspace.git.commit({ message: "must not bypass replay" })).rejects.toMatchObject(
      { code: "EOPACTIVE" },
    );
    await workspace.git.reset({ hard: true });
    expect(store.readOperationState()).toBeNull();
  });
});
