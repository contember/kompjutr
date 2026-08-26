import { describe, expect, it } from "vitest";

import { utf8 } from "../src/core/bytes.js";
import { commitIndex } from "../src/core/ops/commit.js";
import { Repository } from "../src/core/repository.js";
import type { SqlDatabase } from "../src/sqlite/db.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";

class RefWriteFailureDatabase implements SqlDatabase {
  failRefWrites = false;
  objectPayloadWrites = 0;

  constructor(readonly inner: TestDatabase) {}

  run(query: string, ...bindings: unknown[]): void {
    if (this.failRefWrites && query.includes("INSERT INTO git_refs")) {
      throw new Error("injected ref publication failure");
    }
    if (query.includes("INSERT INTO git_object_chunks")) this.objectPayloadWrites++;
    this.inner.run(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    return this.inner.all<Row>(query, ...bindings);
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.inner.one<Row>(query, ...bindings);
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    return this.inner.scalar<T>(query, ...bindings);
  }

  iterate(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    return this.inner.iterate(query, ...bindings);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function open() {
  const db = new RefWriteFailureDatabase(new TestDatabase());
  const database = new SqliteGitDatabase(db);
  const row = database.create("/repo", "ref: refs/heads/main");
  return { db, repo: new Repository(database.open(row), row.root) };
}

describe("commit transactions", () => {
  it("rolls object and cache writes back when ref publication fails", () => {
    const { db, repo } = open();
    const data = utf8.encode("staged\n");
    const blob = repo.store.write("blob", data);
    repo.store.indexPut({
      path: "staged.txt",
      stage: 0,
      mode: 0o100644,
      oid: blob,
      size: data.length,
      mtime: 0,
      ino: 0,
    });
    const expectedHead = repo.head();
    const before = {
      head: repo.store.head(),
      refs: repo.store.listRefs(),
      objects: repo.store.objectCount(),
    };
    db.objectPayloadWrites = 0;
    db.failRefWrites = true;

    expect(() =>
      commitIndex(repo, {
        message: "must roll back",
        parent: [],
        identities: {
          author: {
            name: "Author",
            email: "author@example.com",
            timestamp: 1,
            timezoneOffset: 0,
          },
          committer: {
            name: "Committer",
            email: "committer@example.com",
            timestamp: 2,
            timezoneOffset: 0,
          },
        },
        expectedHead,
        refLogReason: "commit",
      }),
    ).toThrow("injected ref publication failure");

    expect(db.objectPayloadWrites).toBeGreaterThan(0);
    expect(repo.store.head()).toBe(before.head);
    expect(repo.store.listRefs()).toEqual(before.refs);
    expect(repo.store.objectCount()).toBe(before.objects);
    expect(repo.store.db.scalar<number>("SELECT COUNT(*) FROM git_commits")).toBe(0);
    expect(repo.store.db.scalar<number>("SELECT COUNT(*) FROM git_tree_sources")).toBe(0);
    expect(repo.store.db.scalar<number>("SELECT COUNT(*) FROM git_tree_effective")).toBe(0);
    expect(repo.store.db.scalar<number>("SELECT COUNT(*) FROM git_tree_entries")).toBe(0);
  });
});
