import { describe, expect, it } from "vitest";

import { createGit, type GitFactory, Workspace } from "../src/index.js";
import { SqliteTestStorage } from "./helpers/storage.js";

describe("Workspace Git factory", () => {
  it("binds a custom factory to the Workspace database without type shims", async () => {
    const storage = new SqliteTestStorage();
    const seen: string[] = [];
    const factory: GitFactory = (binding) => {
      const client = createGit()(binding);
      return {
        ...client,
        async init(input = {}) {
          seen.push("init");
          await client.init(input);
        },
      };
    };
    const workspace = new Workspace({ storage, git: factory });

    await workspace.fs.writeFile("/README.md", "hello\n");
    await workspace.git.init({});

    expect(workspace.db.scalar<number>("SELECT COUNT(*) FROM git_repositories")).toBe(1);
    expect(await workspace.fs.readFile("/README.md", "utf8")).toBe("hello\n");
    expect(seen).toEqual(["init"]);
  });
});
