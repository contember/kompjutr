import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { comparePaths, joinSorted, peekable } from "../src/core/streams.js";

/**
 * `comparePaths` claims to be SQLite's BINARY collation. That claim is not
 * argued here, it is measured: the same paths go into a TEXT column and the
 * database's own `ORDER BY` is the expected answer.
 */
function sqliteOrder(paths: string[]): string[] {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE t (path TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO t (path) VALUES (?)");
    for (const path of paths) insert.run(path);
    return db
      .prepare("SELECT path FROM t ORDER BY path")
      .all()
      .map((row) => {
        const value = row.path;
        if (typeof value !== "string") throw new Error("path column is not TEXT");
        return value;
      });
  } finally {
    db.close();
  }
}

/** Deterministic shuffle, so `ORDER BY` and the comparator both do real work. */
function shuffled(values: string[]): string[] {
  const out = [...values];
  let seed = 0x2545f491;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    const held = out[i]!;
    out[i] = out[j]!;
    out[j] = held;
  }
  return out;
}

const AWKWARD_PATHS = [
  "",
  " ",
  "!",
  ".gitignore",
  "0",
  "A",
  "README.md",
  "Z",
  "_",
  "a",
  "a-b",
  "a.txt",
  "a/",
  "a/b.txt",
  "a/b/c",
  "a0",
  "ab",
  "e\u0301", // decomposed "e" + combining acute: 65 CC 81
  "z",
  "zz",
  "~",
  "\u007f", // DEL, the last one-byte code point
  "\u0080", // C2 80, the first two-byte one
  "\u00e9", // precomposed "e": C3 A9
  "\u07ff", // DF BF, the last two-byte one
  "\u0800", // E0 A0 80, the first three-byte one
  "\ue000", // private use: EE 80 80
  "\ue000/x",
  "\uffff", // EF BF BF, the last three-byte one
  "\u{10000}", // F0 90 80 80, the first four-byte one
  "\u{1f600}", // F0 9F 98 80
  "\u{1f600}/x",
  "\u{10ffff}", // F4 8F BF BF, the last code point of all
];

describe("comparePaths", () => {
  it("orders exactly as SQLite's BINARY collation does", () => {
    const input = shuffled(AWKWARD_PATHS);
    expect([...input].sort(comparePaths)).toEqual(sqliteOrder(input));
  });

  it("sorts astral code points after the BMP, where UTF-16 order does not", () => {
    // F0 9F 98 80 against EE 80 80 in UTF-8, but 0xd83d against 0xe000 in UTF-16.
    expect(comparePaths("\u{1f600}", "\ue000")).toBeGreaterThan(0);
    expect("\u{1f600}" < "\ue000").toBe(true);
    expect(comparePaths("\u{1f600}/x", "\ue000/x")).toBeGreaterThan(0);
    expect(sqliteOrder(["\u{1f600}/x", "\ue000/x"])).toEqual(["\ue000/x", "\u{1f600}/x"]);
  });

  it("puts a path before the directory of the same name", () => {
    // "." is 0x2e and "/" is 0x2f, so "a.txt" lands before "a/b.txt".
    expect(comparePaths("a", "a/")).toBeLessThan(0);
    expect(comparePaths("a.txt", "a/b.txt")).toBeLessThan(0);
    expect(comparePaths("a/b.txt", "a0")).toBeLessThan(0);
  });

  it("treats a prefix as smaller and equal strings as equal", () => {
    expect(comparePaths("", "")).toBe(0);
    expect(comparePaths("", "a")).toBeLessThan(0);
    expect(comparePaths("a", "")).toBeGreaterThan(0);
    expect(comparePaths("a/b", "a/b")).toBe(0);
    expect(comparePaths("a/b", "a/b/c")).toBeLessThan(0);
    expect(comparePaths("\u{1f600}", "\u{1f600}")).toBe(0);
  });

  it("stays a total order over pure ASCII", () => {
    const ascii: string[] = [];
    for (let code = 0x20; code < 0x7f; code++) ascii.push(String.fromCharCode(code));
    expect(shuffled(ascii).sort(comparePaths)).toEqual(ascii);
  });

  it("folds an unpaired surrogate to U+FFFD, as UTF-8 encoding does", () => {
    // Both leads encode to EF BF BD, so only what follows can separate them.
    expect(comparePaths("\ud83da", "\ud83db")).toBeLessThan(0);
    expect(comparePaths("\ud83d", "\ufffd")).toBe(0);
    // A real pair is four bytes from F0, an unpaired lead three from EF.
    expect(comparePaths("\u{1f600}", "\ud83d")).toBeGreaterThan(0);
    expect(comparePaths("\ud83d", "\u{1f600}")).toBeLessThan(0);
  });
});

describe("peekable", () => {
  it("looks ahead without consuming", () => {
    const stream = peekable(["a", "b"]);
    expect(stream.peek()).toBe("a");
    expect(stream.peek()).toBe("a");
    expect(stream.next()).toBe("a");
    expect(stream.next()).toBe("b");
    expect(stream.peek()).toBeUndefined();
    expect(stream.next()).toBeUndefined();
  });

  it("pulls at most one item ahead of what was taken", () => {
    let pulled = 0;
    function* counted(): Generator<number> {
      for (let i = 0; ; i++) {
        pulled++;
        yield i;
      }
    }
    const stream = peekable(counted());
    expect(pulled).toBe(0);
    stream.peek();
    expect(pulled).toBe(1);
    stream.peek();
    expect(pulled).toBe(1);
    stream.next();
    expect(pulled).toBe(1);
    stream.next();
    expect(pulled).toBe(2);
  });

  it("stays exhausted without pulling again", () => {
    let resumes = 0;
    function* once(): Generator<string> {
      resumes++;
      yield "a";
      resumes++;
    }
    const stream = peekable(once());
    expect(stream.next()).toBe("a");
    expect(stream.next()).toBeUndefined();
    expect(stream.next()).toBeUndefined();
    expect(resumes).toBe(2);
  });
});

const byIdentity = { left: (item: string) => item, right: (item: string) => item };

/** `[path, left, right]`, so an expectation reads as one line per path. */
function joinTriples(left: string[], right: string[]): [string, string | null, string | null][] {
  return [...joinSorted(left, right, byIdentity)].map((row) => [
    row.path,
    row.left ?? null,
    row.right ?? null,
  ]);
}

describe("joinSorted", () => {
  it("yields both sides of a shared path once", () => {
    expect(joinTriples(["a", "b"], ["a", "b"])).toEqual([
      ["a", "a", "a"],
      ["b", "b", "b"],
    ]);
  });

  it("yields left-only and right-only paths", () => {
    expect(joinTriples(["a"], ["b"])).toEqual([
      ["a", "a", null],
      ["b", null, "b"],
    ]);
  });

  it("interleaves both sides in path order", () => {
    expect(joinTriples(["a", "c", "d", "f"], ["b", "c", "e", "f", "g"])).toEqual([
      ["a", "a", null],
      ["b", null, "b"],
      ["c", "c", "c"],
      ["d", "d", null],
      ["e", null, "e"],
      ["f", "f", "f"],
      ["g", null, "g"],
    ]);
  });

  it("drains a side on its own when the other is empty", () => {
    expect(joinTriples(["a", "b"], [])).toEqual([
      ["a", "a", null],
      ["b", "b", null],
    ]);
    expect(joinTriples([], ["a", "b"])).toEqual([
      ["a", null, "a"],
      ["b", null, "b"],
    ]);
  });

  it("yields nothing when both sides are empty", () => {
    expect(joinTriples([], [])).toEqual([]);
  });

  it("merges in UTF-8 order, not UTF-16 order", () => {
    expect(joinTriples(["\u{1f600}"], ["\ue000"])).toEqual([
      ["\ue000", null, "\ue000"],
      ["\u{1f600}", "\u{1f600}", null],
    ]);
  });

  it("yields a repeated key once per repeat, pairing only the first", () => {
    // Index rows repeat a path across stages; this is what that does here.
    expect(joinTriples(["a", "a", "b"], ["a", "b"])).toEqual([
      ["a", "a", "a"],
      ["a", "a", null],
      ["b", "b", "b"],
    ]);
  });

  it("keys each side with its own accessor", () => {
    const left = [{ path: "a", mode: 1 }];
    const right = [{ name: "a" }, { name: "b" }];
    const rows = [
      ...joinSorted(left, right, { left: (item) => item.path, right: (item) => item.name }),
    ];
    expect(rows).toEqual([
      { path: "a", left: { path: "a", mode: 1 }, right: { name: "a" } },
      { path: "b", left: undefined, right: { name: "b" } },
    ]);
  });

  it("pulls nothing before the first row is asked for", () => {
    let pulls = 0;
    function* tracked(values: string[]): Generator<string> {
      for (const value of values) {
        pulls++;
        yield value;
      }
    }
    const rows = joinSorted(tracked(["a", "b"]), tracked(["a", "b"]), byIdentity);
    expect(pulls).toBe(0);
    rows.next();
    expect(pulls).toBe(2);
  });

  it("does not read past the rows it has yielded", () => {
    // Five rows need three items from each side; a fourth read is a bug.
    function* fenced(values: string[]): Generator<string> {
      for (const [index, value] of values.entries()) {
        if (index > 2) throw new Error(`read too far: ${value}`);
        yield value;
      }
    }
    const rows = joinSorted(
      fenced(["a", "c", "e", "g", "i"]),
      fenced(["b", "d", "f", "h", "j"]),
      byIdentity,
    );
    const taken: string[] = [];
    for (let i = 0; i < 5; i++) {
      const step = rows.next();
      expect(step.done).toBe(false);
      if (step.done === false) taken.push(step.value.path);
    }
    expect(taken).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("holds one item per side, whatever the input length", () => {
    // Infinite on both sides: this can only terminate if nothing is buffered.
    function* countUp(offset: number): Generator<string> {
      for (let i = offset; ; i += 2) yield String(i).padStart(12, "0");
    }
    const rows = joinSorted(countUp(0), countUp(1), byIdentity);
    const taken: string[] = [];
    for (let i = 0; i < 6; i++) {
      const step = rows.next();
      if (step.done === false) taken.push(step.value.path);
    }
    expect(taken).toEqual([
      "000000000000",
      "000000000001",
      "000000000002",
      "000000000003",
      "000000000004",
      "000000000005",
    ]);
  });
});
