import { describe, expect, it } from "vitest";
import { Workspace } from "@cloudflare/computer";
import type { GitClient, GitClientFactory } from "@cloudflare/computer/git";
import { SqliteTestStorage } from "./helpers/storage.js";

describe("phase 0 spike", () => {
  it("runs a Workspace in node with a custom git factory", async () => {
    const storage = new SqliteTestStorage();
    const seen: string[] = [];
    const factory: GitClientFactory = ({ ws }) => {
      const provider = ws.provider();
      provider.db.run("CREATE TABLE IF NOT EXISTS git_probe (k TEXT PRIMARY KEY, v TEXT)");
      const client = {
        async init() {
          provider.db.run("INSERT OR REPLACE INTO git_probe VALUES ('head', 'ref: refs/heads/main')");
          seen.push("init");
        },
      } as unknown as GitClient;
      return client;
    };
    const ws = new Workspace({ storage, git: factory });
    await ws.fs.writeFile("/README.md", "hello\n");
    await ws.git.init({});
    const row = ws.provider().db.one<{ v: string }>("SELECT v FROM git_probe WHERE k = 'head'");
    expect(row?.v).toBe("ref: refs/heads/main");
    expect(await ws.fs.readFile("/README.md", "utf8")).toBe("hello\n");
    expect(seen).toEqual(["init"]);
  });
});
