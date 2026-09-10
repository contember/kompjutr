import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { SqliteGitDatabase } from "../packages/git/src/store/index.js";
import { TestDatabase } from "../tests/helpers/db.js";
import { GitFixture } from "../tests/helpers/git.js";
import { startGitServer } from "../tests/helpers/http-backend.js";
import { FIXTURES, prepareFixture } from "./fixtures.js";
import type { Scenario, ScenarioContext } from "./harness.js";

export function nextjsNetwork(mode: "legacy" | "mapped"): Scenario {
  let fixture: GitFixture;
  let server: Awaited<ReturnType<typeof startGitServer>>;
  let base = "";
  let next = "";
  async function verify(context: ScenarioContext, expected: string): Promise<void> {
    const { git } = context.harness;
    const actual = await git.revParse({ dir: "/repo", ref: "refs/remotes/origin/main" });
    if (actual !== expected) throw new Error(`fetch published ${actual}, expected ${expected}`);
    const commits = await git.log({ dir: "/repo", ref: actual });
    if (commits.length !== (expected === base ? 1 : 2))
      throw new Error("incomplete fetched history");
    const database = new SqliteGitDatabase(new TestDatabase(context.harness.storage));
    const checkout = database.findCheckout("/repo");
    if (checkout === null) throw new Error("missing checkout");
    const store = database.openCheckout(checkout).shared;
    for (const commit of commits) {
      let count = 0;
      let page: string[] = [];
      for (const entry of store.walkTree(commit.tree)) {
        count++;
        if (entry.mode === "160000") continue;
        page.push(entry.oid);
        if (page.length === 512) {
          store.objectInfo(page);
          page = [];
        }
      }
      if (page.length > 0) store.objectInfo(page);
      if (count !== FIXTURES.nextjs.files) throw new Error("incomplete fetched tree");
    }
  }
  async function fetch(context: ScenarioContext): Promise<void> {
    await context.harness.git.fetch({
      dir: "/repo",
      remote: "origin",
      ...(mode === "legacy"
        ? { singleBranch: false, tags: false }
        : {
            refspecs: [
              { source: "refs/heads/main", destination: "refs/remotes/origin/main", force: true },
            ],
          }),
    });
  }
  return {
    name: `nextjs-network-${mode}`,
    kind: "macro",
    async setup() {
      const cached = prepareFixture(FIXTURES.nextjs);
      fixture = new GitFixture();
      execFileSync("git", ["clone", "--bare", "--shared", "-q", cached, fixture.dir]);
      base = fixture.git("rev-parse", "refs/heads/main");
      const index = join(fixture.dir, "network-index");
      const env = { GIT_INDEX_FILE: index };
      fixture.gitWithEnv(env, "read-tree", base);
      const content = `${fixture.git("show", `${base}:contributing.md`)}\nNetwork integrity benchmark change.\n`;
      const blob = fixture.gitInput(content, "hash-object", "-w", "--stdin");
      fixture.gitWithEnv(env, "update-index", "--cacheinfo", `100644,${blob},contributing.md`);
      const tree = fixture.gitWithEnv(env, "write-tree");
      next = fixture.git("commit-tree", tree, "-p", base, "-m", "Change one file");
      server = await startGitServer(fixture.dir);
      process.stdout.write(
        `${JSON.stringify({ fixtureRevision: base, nextRevision: next, mode })}\n`,
      );
    },
    phases: [
      {
        name: "git.clone",
        async run({ harness }) {
          await harness.git.clone({
            url: server.url,
            dir: "/repo",
            depth: 0,
            singleBranch: true,
            noTags: true,
          });
        },
        verify: (context) => verify(context, base),
      },
      {
        name: `git.fetch (${mode}, unchanged)`,
        run: fetch,
        verify: (context) => verify(context, base),
      },
      {
        name: `git.fetch (${mode}, one changed file)`,
        async before() {
          fixture.git("update-ref", "refs/heads/main", next);
        },
        run: fetch,
        verify: (context) => verify(context, next),
      },
    ],
    async teardown() {
      await server?.close();
      fixture?.dispose();
    },
  };
}
