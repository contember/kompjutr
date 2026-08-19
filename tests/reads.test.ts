import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { utf8Decoder } from "../src/core/bytes.js";
import { catFile, log, lsFilesAtRef, lsTree, show } from "../src/core/ops/reads.js";
import { Repository } from "../src/core/repository.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";

let fixture: GitFixture;
let repo: Repository;

beforeAll(async () => {
  fixture = new GitFixture().init();
  fixture.write("README.md", "# demo\n");
  fixture.write("src/a.ts", "export const a = 1;\n");
  fixture.write("src/nested/b.ts", "export const b = 2;\n");
  fixture.commit("first");
  fixture.write("src/a.ts", "export const a = 2;\n");
  fixture.commit("second");
  fixture.git("checkout", "-q", "-b", "side", "HEAD~1");
  fixture.write("side.txt", "on the side\n");
  fixture.commit("side commit");
  fixture.git("checkout", "-q", "main");
  fixture.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
  fixture.git("tag", "v1");

  const database = new SqliteGitDatabase(new TestDatabase());
  const store = database.open(database.create("/repo", "ref: refs/heads/main"));
  await importFixture(fixture, store);
  repo = new Repository(store, "/repo");
});

afterAll(() => fixture.dispose());

describe("rev-parse", () => {
  it("matches git for refs, suffixes and abbreviations", () => {
    for (const expression of [
      "HEAD",
      "main",
      "side",
      "v1",
      "HEAD~1",
      "HEAD~2",
      "HEAD^",
      "HEAD^2",
      "HEAD^1^",
      "refs/heads/main",
    ]) {
      expect(repo.revParse(expression), expression).toBe(fixture.git("rev-parse", expression));
    }
    const head = fixture.git("rev-parse", "HEAD");
    expect(repo.revParse(head.slice(0, 8))).toBe(head);
  });

  it("reports an unknown revision", () => {
    expect(() => repo.revParse("nope")).toThrow(/unknown revision/);
    expect(() => repo.revParse("HEAD~99")).toThrow(/unknown revision/);
  });

  it("reports the current branch", () => {
    expect(repo.head().ref).toBe("refs/heads/main");
    expect(repo.branches().sort()).toEqual(["main", "side"]);
    expect(repo.tags()).toEqual(["v1"]);
  });
});

describe("log", () => {
  it("visits the same commits git does", () => {
    const ours = log(repo).map((entry) => entry.oid);
    const theirs = fixture.git("rev-list", "HEAD").split("\n");
    expect(ours).toEqual(theirs);
  });

  it("honours depth", () => {
    expect(log(repo, { depth: 2 })).toHaveLength(2);
  });

  it("reads authorship the way git records it", () => {
    const head = show(repo, "HEAD");
    expect(head.author.name).toBe("Fixture");
    expect(head.author.email).toBe("fixture@example.com");
    expect(head.author.timestamp).toBe(Number(fixture.git("show", "-s", "--format=%at", "HEAD")));
    expect(head.message.trim()).toBe("merge side");
    expect(head.parent).toHaveLength(2);
  });
});

describe("ls-tree and cat-file", () => {
  it("lists one level like git", () => {
    const ours = lsTree(repo, "HEAD").map((e) => `${e.mode} ${e.type} ${e.oid}\t${e.path}`);
    const theirs = fixture.git("ls-tree", "HEAD").split("\n");
    expect(ours).toEqual(theirs);
  });

  it("lists a subdirectory", () => {
    const ours = lsTree(repo, "HEAD", "src").map((e) => `${e.mode} ${e.type} ${e.oid}\t${e.path}`);
    const theirs = fixture.git("ls-tree", "HEAD", "src/").split("\n");
    expect(ours).toEqual(theirs);
  });

  it("lists every path in a tree", () => {
    expect(lsFilesAtRef(repo, "HEAD")).toEqual(
      fixture.git("ls-tree", "-r", "--name-only", "HEAD").split("\n").sort(),
    );
  });

  it("reads a blob through the <ref>:<path> shorthand", () => {
    const result = catFile(repo, "HEAD:src/a.ts");
    expect(utf8Decoder.decode(result.bytes)).toBe("export const a = 2;\n");
    expect(result.type).toBe("blob");
  });
});
