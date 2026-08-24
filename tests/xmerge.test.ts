import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  DEFAULT_TEXT_MERGE_LIMITS,
  estimateTextMergeMemory,
  mergeText,
  type TextMergeOptions,
  type TextMergeStyle,
} from "../src/core/diff/index.js";

const utf8 = new TextEncoder();
const scratch = mkdtempSync(join(tmpdir(), "kompjutr-xmerge-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function bytes(text: string): Uint8Array {
  return utf8.encode(text);
}

function gitMergeFile(
  base: Uint8Array,
  current: Uint8Array,
  incoming: Uint8Array,
  style: TextMergeStyle = "merge",
  markerSize = 7,
): { content: Uint8Array; conflicts: boolean } {
  const prefix = join(scratch, `${Date.now()}-${Math.random()}`);
  const currentPath = `${prefix}-current`;
  const basePath = `${prefix}-base`;
  const incomingPath = `${prefix}-incoming`;
  writeFileSync(currentPath, current);
  writeFileSync(basePath, base);
  writeFileSync(incomingPath, incoming);
  const args = [
    "merge-file",
    "-p",
    `--marker-size=${markerSize}`,
    "-L",
    "current",
    "-L",
    "base",
    "-L",
    "incoming",
  ];
  if (style === "diff3") args.push("--diff3");
  if (style === "zdiff3") args.push("--zdiff3");
  args.push(currentPath, basePath, incomingPath);
  try {
    return {
      content: new Uint8Array(
        execFileSync("git", args, {
          env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        }),
      ),
      conflicts: false,
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number" &&
      error.status > 0 &&
      error.status < 128 &&
      "stdout" in error &&
      error.stdout instanceof Uint8Array
    ) {
      return { content: new Uint8Array(error.stdout), conflicts: true };
    }
    throw error;
  }
}

function expectGitParity(
  name: string,
  base: Uint8Array,
  current: Uint8Array,
  incoming: Uint8Array,
  style: TextMergeStyle = "merge",
  markerSize = 7,
): void {
  const expected = gitMergeFile(base, current, incoming, style, markerSize);
  const actual = mergeText(base, current, incoming, {
    style,
    markerSize,
    labels: { current: "current", base: "base", incoming: "incoming" },
  });
  if (actual.kind === "binary") throw new Error(`${name}: unexpected binary result`);
  expect(actual.kind, name).toBe(expected.conflicts ? "conflict" : "clean");
  expect(actual.content, name).toEqual(expected.content);
}

function withLimits(limits: TextMergeOptions["limits"]): TextMergeOptions {
  return {
    labels: { current: "current", base: "base", incoming: "incoming" },
    limits: { ...limits, maxMemoryBytes: DEFAULT_TEXT_MERGE_LIMITS.maxMemoryBytes },
  };
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function editLines(source: string[], random: () => number, side: string): string[] {
  const result = [...source];
  const edits = 1 + Math.floor(random() * 6);
  for (let edit = 0; edit < edits; edit++) {
    const at = Math.floor(random() * (result.length + 1));
    const choice = random();
    if (choice < 0.3 && result.length > 0) result.splice(Math.min(at, result.length - 1), 1);
    else if (choice < 0.6) result.splice(at, 0, `${side} inserted ${edit}\n`);
    else if (result.length > 0)
      result[Math.min(at, result.length - 1)] = `${side} changed ${edit}\n`;
  }
  return result;
}

describe("bounded byte-oriented xmerge", () => {
  it("matches git merge-file across clean, refined, marker, and newline cases", () => {
    const cases: {
      name: string;
      base: Uint8Array;
      current: Uint8Array;
      incoming: Uint8Array;
      styles?: TextMergeStyle[];
    }[] = [
      {
        name: "independent edits",
        base: bytes("first\nmiddle\nlast\n"),
        current: bytes("FIRST\nmiddle\nlast\n"),
        incoming: bytes("first\nmiddle\nLAST\n"),
      },
      {
        name: "refined conflict",
        base: bytes("head\none\ntwo\nthree\ntail\n"),
        current: bytes("head\nONE\ntwo\nTHREE-current\ntail\n"),
        incoming: bytes("head\nONE-incoming\ntwo\nTHREE\ntail\n"),
      },
      {
        name: "all marker styles",
        base: bytes("head\nbase\ntail\n"),
        current: bytes("head\ncurrent\ntail\n"),
        incoming: bytes("head\nincoming\ntail\n"),
        styles: ["merge", "diff3", "zdiff3"],
      },
      {
        name: "CRLF",
        base: bytes("head\r\nbase\r\ntail\r\n"),
        current: bytes("head\r\ncurrent\r\ntail\r\n"),
        incoming: bytes("head\r\nincoming\r\ntail\r\n"),
        styles: ["merge", "diff3", "zdiff3"],
      },
      {
        name: "missing final newline",
        base: bytes("head\nbase"),
        current: bytes("head\ncurrent"),
        incoming: bytes("head\nincoming"),
        styles: ["merge", "diff3", "zdiff3"],
      },
      {
        name: "punctuation gap uses zealous-alnum simplification",
        base: bytes("a\nbase one\n----\n====\n....\n++++\nbase two\nz\n"),
        current: bytes("a\ncurrent one\n----\n====\n....\n++++\ncurrent two\nz\n"),
        incoming: bytes("a\nincoming one\n----\n====\n....\n++++\nincoming two\nz\n"),
      },
    ];
    for (const testCase of cases) {
      for (const style of testCase.styles ?? ["merge"]) {
        expectGitParity(
          `${testCase.name} (${style})`,
          testCase.base,
          testCase.current,
          testCase.incoming,
          style,
        );
      }
    }
  });

  it("preserves arbitrary non-UTF-8 bytes", () => {
    const base = new Uint8Array([0x61, 0x0a, 0x80, 0x0a, 0x7a, 0x0a]);
    const current = new Uint8Array([0x61, 0x0a, 0xfe, 0x0a, 0x7a, 0x0a]);
    const incoming = new Uint8Array([0x61, 0x0a, 0xff, 0x0a, 0x7a, 0x0a]);
    expectGitParity("non-UTF-8", base, current, incoming);
    const result = mergeText(base, current, incoming);
    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") throw new Error("expected a conflict");
    expect(result.content).toContain(0xfe);
    expect(result.content).toContain(0xff);
  });

  it("matches git merge-file over deterministic random edits", () => {
    const random = makeRandom(0x584d4552);
    const alphabet = ["alpha\n", "beta\n", "\n", "    indented\n", "!\n", "omega\n"];
    for (let round = 0; round < 100; round++) {
      const count = 3 + Math.floor(random() * 24);
      const baseLines = Array.from(
        { length: count },
        () => alphabet[Math.floor(random() * alphabet.length)]!,
      );
      const currentLines = editLines(baseLines, random, "current");
      const incomingLines = editLines(baseLines, random, "incoming");
      expectGitParity(
        `random round ${round}`,
        bytes(baseLines.join("")),
        bytes(currentLines.join("")),
        bytes(incomingLines.join("")),
      );
    }
  });

  it("returns binary without decoding or allocating an output", () => {
    const result = mergeText(
      new Uint8Array([0x61, 0, 0x62]),
      new Uint8Array([0x61, 0, 0x63]),
      new Uint8Array([0x61, 0, 0x64]),
    );
    expect(result.kind).toBe("binary");
    expect(result.memory.outputBytes).toBe(0);
  });

  it("supports labels and custom marker sizes", () => {
    expectGitParity(
      "custom marker size",
      bytes("base\n"),
      bytes("current\n"),
      bytes("incoming\n"),
      "diff3",
      13,
    );
  });

  it("fails closed at input, line, change, conflict, output, and label boundaries", () => {
    const base = bytes("base\n");
    const current = bytes("current\n");
    const incoming = bytes("incoming\n");
    const run = (options: TextMergeOptions): ReturnType<typeof mergeText> =>
      mergeText(base, current, incoming, options);
    expect(() => run(withLimits({ maxInputBytes: 9 }))).not.toThrow();
    expect(() => run(withLimits({ maxInputBytes: 8 }))).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(() => run(withLimits({ maxTotalInputBytes: 22 }))).not.toThrow();
    expect(() => run(withLimits({ maxTotalInputBytes: 21 }))).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );

    expect(() => run(withLimits({ maxLineBytes: 9 }))).not.toThrow();
    expect(() => run(withLimits({ maxLineBytes: 8 }))).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(() => run(withLimits({ maxLines: 3 }))).not.toThrow();
    expect(() => run(withLimits({ maxLines: 2 }))).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );

    expect(() => run(withLimits({ maxChanges: 2 }))).not.toThrow();
    expect(() => run(withLimits({ maxChanges: 1 }))).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(() => run(withLimits({ maxConflicts: 1 }))).not.toThrow();
    expect(() => run(withLimits({ maxConflicts: 0 }))).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(() => run(withLimits({ maxConflictBytes: 17 }))).not.toThrow();
    expect(() => run(withLimits({ maxConflictBytes: 16 }))).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );

    const full = run(withLimits({}));
    if (full.kind === "binary") throw new Error("expected text output");
    expect(() => run(withLimits({ maxOutputBytes: full.content.length }))).not.toThrow();
    expect(() => run(withLimits({ maxOutputBytes: full.content.length - 1 }))).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );

    expect(() =>
      run({
        labels: { current: "12345678", base: "12345678", incoming: "12345678" },
        limits: { maxLabelBytes: 8 },
      }),
    ).not.toThrow();
    expect(() =>
      run({ labels: { current: "123456789" }, limits: { maxLabelBytes: 8 } }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(() => run({ labels: { current: "unsafe\nlabel" } })).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => run({ markerSize: 8, limits: { maxMarkerSize: 8 } })).not.toThrow();
    expect(() => run({ markerSize: 9, limits: { maxMarkerSize: 8 } })).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
    expect(() =>
      run({ limits: { maxInputBytes: DEFAULT_TEXT_MERGE_LIMITS.maxInputBytes + 1 } }),
    ).toThrowError(expect.objectContaining({ code: "EINVAL" }));
  });

  it("exposes a conservative memory reservation and rejects its next boundary", () => {
    const base = bytes("a\nbase\nz\n");
    const current = bytes("a\ncurrent\nz\n");
    const incoming = bytes("a\nincoming\nz\n");
    const estimate = estimateTextMergeMemory(base, current, incoming);
    expect(estimate.peakBytes).toBe(
      estimate.inputBytes +
        estimate.lineTableBytes +
        estimate.diffWorkspaceBytes +
        estimate.changeListBytes +
        estimate.mergeListBytes +
        estimate.outputBytes +
        estimate.fixedBytes,
    );
    expect(() =>
      mergeText(base, current, incoming, { limits: { maxMemoryBytes: estimate.peakBytes } }),
    ).not.toThrow();
    expect(() =>
      mergeText(base, current, incoming, { limits: { maxMemoryBytes: estimate.peakBytes - 1 } }),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });
});
