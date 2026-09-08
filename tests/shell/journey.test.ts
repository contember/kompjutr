// One mixed workflow proving that control flow, streaming, set mutations, and
// shared limits compose rather than only passing in isolation.
import { expect, it } from "vitest";
import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { encode } from "../../packages/do/src/shell/exec/bytes.js";
import { type Command, createShell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
it("composes the complete bounded shell contract", async () => {
  let now = 100;
  const fs = createFilesystem(new TestDatabase(), { now: () => now });
  fs.writeFiles([
    {
      path: "/repo/src/a.txt",
      bytes: ENCODER.encode("zeta\n"),
      contentId: new Uint8Array([1, 2, 3]),
    },
    { path: "/repo/src/b.txt", bytes: ENCODER.encode("alpha\n") },
    { path: "/repo/src/c.md", bytes: ENCODER.encode("skip\n") },
    { path: "/repo/src/nested/d.txt", bytes: ENCODER.encode("beta\n") },
  ]);
  now = 200;
  const announce: Command = (context) => ({
    stdout: (function* () {
      context.warn("warning");
      yield encode("payload\n");
    })(),
    status: () => 0,
  });
  const shell = createShell({
    fs,
    cwd: "/repo",
    commands: new Map([["announce", announce]]),
    limits: {
      maxOutputBytes: 512,
      maxOperations: 32,
      readBudget: 64,
      maxRetainedBytes: 256,
    },
  });
  const run = await shell.run(
    "false && echo skipped || echo recovered; " +
      "announce 2>&1 | head -2; " +
      "find src -name '*.txt' | head -2 > found; " +
      "ls -R src | head -6; " +
      "cp -r src copy; " +
      "touch copy/a.txt copy; " +
      "sort found | xargs echo selected: > summary",
  );
  expect(run).toMatchObject({
    stdout:
      "recovered\n" +
      "announce: warning\n" +
      "payload\n" +
      "/repo/src:\n" +
      "a.txt\n" +
      "b.txt\n" +
      "c.md\n" +
      "nested\n\n",
    stderr: "",
    exitCode: 0,
    cwd: "/repo",
    truncated: false,
  });
  expect(run.operations).toBeLessThanOrEqual(16);
  expect(run.peakRetainedBytes).toBeGreaterThan(0);
  expect(run.peakRetainedBytes).toBeLessThanOrEqual(256);
  expect(DECODER.decode(fs.readFile("/repo/found"))).toBe("/repo/src/a.txt\n/repo/src/b.txt\n");
  expect(DECODER.decode(fs.readFile("/repo/summary"))).toBe(
    "selected: /repo/src/a.txt /repo/src/b.txt\n",
  );
  expect(DECODER.decode(fs.readFile("/repo/copy/nested/d.txt"))).toBe("beta\n");
  expect(fs.stat("/repo/copy")?.mtime).toBe(200);
  expect(fs.stat("/repo/copy/a.txt")).toMatchObject({ mtime: 200 });
  expect(fs.stat("/repo/copy/a.txt")?.contentId).toEqual(new Uint8Array([1, 2, 3]));
  expect(fs.stat("/repo/copy/b.txt")?.mtime).toBe(100);
});
