// A detached auto-maintenance run repacks a fixture behind the test's back and
// races its removal (ENOTEMPTY). Both ways tests spawn git must turn it off.
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { GitFixture } from "./helpers/git.js";

const fixtures: GitFixture[] = [];
afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.dispose();
});

function traceCommit(env: NodeJS.ProcessEnv): string {
  const source = new GitFixture().init();
  fixtures.push(source);
  source.write("a.txt", "a\n");
  source.git("add", "a.txt");
  const result = spawnSync("git", ["commit", "-qm", "a"], {
    cwd: source.dir,
    env: { ...env, GIT_TRACE: "1" },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return result.stderr;
}

describe("git spawned by tests", () => {
  it("starts no auto maintenance through the fixture environment", () => {
    const source = new GitFixture().init();
    fixtures.push(source);
    expect(source.git("config", "--get", "maintenance.auto")).toBe("false");
  });

  it("starts no auto maintenance through the inherited process environment", () => {
    const trace = traceCommit({
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    });
    expect(trace).toContain("built-in: git commit");
    expect(trace).not.toContain("maintenance run");
  });
});
