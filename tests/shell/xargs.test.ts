// `xargs` is the pipeline shape the planner's R2 refuses to fuse. Before it
// existed those lines died with "command not found"; these cases are the
// ones R2 leaves behind on purpose.
import { beforeEach, describe, expect, it } from "vitest";
import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { type ByteStream, encode } from "../../packages/do/src/shell/exec/bytes.js";
import {
  type Command,
  type RetainedBudget,
  result,
} from "../../packages/do/src/shell/exec/context.js";
import { createShell, type Shell } from "../../packages/do/src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

const ENCODER = new TextEncoder();
let shell: Shell;
beforeEach(() => {
  const fs = createFilesystem(new TestDatabase(), { now: () => 1700000000000 });
  fs.writeFiles([
    { path: "/repo/a.ts", bytes: ENCODER.encode("alpha\nNEEDLE\n") },
    { path: "/repo/b.ts", bytes: ENCODER.encode("beta\n") },
    { path: "/repo/c.ts", bytes: ENCODER.encode("gamma\nNEEDLE\n") },
    { path: "/repo/list.txt", bytes: ENCODER.encode("a.ts\nb.ts\n") },
    { path: "/repo/spaced name.txt", bytes: ENCODER.encode("spaced\n") },
  ]);
  shell = createShell({ fs, cwd: "/repo" });
});
describe("the shape R2 does not fuse", () => {
  it("runs a command over find's output", async () => {
    // `xargs cat` is not a search, so R2 leaves it alone and this runs.
    const run = await shell.run("find /repo -name '*.ts' | xargs cat");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("alpha\nNEEDLE\nbeta\ngamma\nNEEDLE\n");
  });
  it("honours -n, which R2 also refuses", async () => {
    const run = await shell.run("find /repo -name '*.ts' | xargs -n1 grep -c NEEDLE");
    // One invocation per file: 1, 0, 1 — and grep's exit 1 on the miss makes
    // the whole xargs report 123, as GNU does.
    expect(run.stdout).toBe("1\n0\n1\n");
    expect(run.exitCode).toBe(123);
  });
  it("substitutes with -I", async () => {
    const run = await shell.run("cat list.txt | xargs -I{} echo file:{}");
    expect(run.stdout).toBe("file:a.ts\nfile:b.ts\n");
  });
  it("keeps -I line-oriented so a space survives", async () => {
    const run = await shell.run("ls | grep spaced | xargs -I{} echo [{}]");
    expect(run.stdout).toBe("[spaced name.txt]\n");
  });
  it("splits on whitespace without -I, which is why the space needs -0", async () => {
    const run = await shell.run("echo one two three | xargs echo");
    expect(run.stdout).toBe("one two three\n");
  });
});
describe("empty input", () => {
  it("runs once with no arguments, as GNU does", async () => {
    expect((await shell.run("grep -r zzz /repo | xargs echo done")).stdout).toBe("done\n");
  });
  it("skips the run with -r", async () => {
    expect((await shell.run("grep -r zzz /repo | xargs -r echo done")).stdout).toBe("");
  });
  it("never runs -I on nothing to substitute", async () => {
    expect((await shell.run("grep -r zzz /repo | xargs -I{} echo [{}]")).stdout).toBe("");
  });
});
describe("boundaries", () => {
  it("reports a command it cannot run", async () => {
    const run = await shell.run("cat list.txt | xargs bun");
    expect(run.exitCode).toBe(127);
    expect(run.stderr).toContain("command not found");
  });
  it("stays lazy enough for a trailing head", async () => {
    const run = await shell.run("find /repo -name '*.ts' | xargs -n1 cat | head -1");
    expect(run.stdout).toBe("alpha\n");
  });
  it("releases buffered groups when head closes before the first pull", async () => {
    const reserve: Command = (context) => {
      const release = context.fs.retained.retain(context.fs.retained.max, "reserve witness");
      release();
      return result((function* (): ByteStream {})());
    };
    const bounded = createShell({
      fs: createFilesystem(new TestDatabase()),
      commands: new Map([["reserve", reserve]]),
      limits: {
        maxOutputBytes: 100,
        maxOperations: 100,
        readBudget: 32,
        maxRetainedBytes: 32,
      },
    });

    expect(await bounded.run("echo item | xargs echo | head -0; reserve")).toMatchObject({
      stdout: "",
      stderr: "",
      exitCode: 0,
      peakRetainedBytes: 32,
    });
  });
  it("counts sub-invocations against the caller's ceiling", async () => {
    const fs = createFilesystem(new TestDatabase());
    fs.writeFiles(
      Array.from({ length: 50 }, (_, index) => ({
        path: `/repo/f${index}.txt`,
        bytes: ENCODER.encode(`${index}\n`),
      })),
    );
    const bounded = createShell({
      fs,
      cwd: "/repo",
      limits: { maxOutputBytes: 1000000, maxOperations: 8, readBudget: 1500000 },
    });
    // Fifty invocations cannot buy fifty budgets by spreading the work.
    const run = await bounded.run("find /repo -name '*.txt' | xargs -n1 cat");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("filesystem operations");
  });
  it("rejects a flag it cannot honour", async () => {
    const run = await shell.run("cat list.txt | xargs -n0 echo");
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("-n must be at least 1");
  });

  it("runs multiple async children sequentially and drains each before the next", async () => {
    const events: string[] = [];
    const child: Command = async (context) => {
      const value = context.argv[0] ?? "";
      events.push(`start:${value}`);
      await Promise.resolve();
      return result(
        (async function* (): ByteStream {
          events.push(`pull:${value}`);
          await Promise.resolve();
          yield encode(`${value}\n`);
          events.push(`done:${value}`);
        })(),
      );
    };
    const fs = createFilesystem(new TestDatabase());
    const asyncShell = createShell({
      fs,
      commands: new Map([["child", child]]),
    });

    expect((await asyncShell.run("echo a b c | xargs -n1 child")).stdout).toBe("a\nb\nc\n");
    expect(events).toEqual([
      "start:a",
      "pull:a",
      "done:a",
      "start:b",
      "pull:b",
      "done:b",
      "start:c",
      "pull:c",
      "done:c",
    ]);
  });
  it("settles child status and truncation after an early downstream close", async () => {
    let closes = 0;
    let childStatus = 0;
    let childTruncated = false;
    let sent = false;
    const stdout: AsyncIterableIterator<Uint8Array, void, undefined> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<Uint8Array, void>> {
        if (sent) return { done: true, value: undefined };
        sent = true;
        return { done: false, value: encode("child output\n") };
      },
      async return(): Promise<IteratorResult<Uint8Array, void>> {
        closes++;
        childStatus = 7;
        childTruncated = true;
        return { done: true, value: undefined };
      },
    };
    const child: Command = () => ({
      stdout,
      status: () => childStatus,
      truncated: () => childTruncated,
    });
    const bounded = createShell({
      fs: createFilesystem(new TestDatabase()),
      commands: new Map([["child", child]]),
      limits: {
        maxOutputBytes: 1,
        maxOperations: 100,
        readBudget: 32,
        maxRetainedBytes: 64,
      },
    });

    expect(await bounded.run("echo item | xargs child")).toMatchObject({
      stdout: "c",
      exitCode: 123,
      truncated: true,
    });
    expect(closes).toBe(1);
  });
  it("closes a rejecting child once and releases every retained byte", async () => {
    const failure = new Error("child next rejected");
    let closes = 0;
    let retained: RetainedBudget | undefined;
    const child: Command = (context) => {
      retained = context.fs.retained;
      const stdout: AsyncIterableIterator<Uint8Array, void, undefined> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next(): Promise<IteratorResult<Uint8Array, void>> {
          await Promise.resolve();
          throw failure;
        },
        async return(): Promise<IteratorResult<Uint8Array, void>> {
          closes++;
          return { done: true, value: undefined };
        },
      };
      return {
        stdout,
        status: () => 9,
        truncated: () => true,
      };
    };
    const rejecting = createShell({
      fs: createFilesystem(new TestDatabase()),
      commands: new Map([["child", child]]),
    });

    await expect(rejecting.run("echo item | xargs child")).rejects.toThrow(failure);
    expect(closes).toBe(1);
    expect(retained?.available).toBe(retained?.max);
  });
});
describe("R2 still wins where it applies", () => {
  it("fuses the search shape rather than running xargs", async () => {
    // Same answer, but no xargs invocation at all — the planner collapsed it.
    const run = await shell.run("find /repo -name '*.ts' | xargs grep -l NEEDLE");
    expect(run.stdout.split("\n").filter(Boolean)).toEqual(["/repo/a.ts", "/repo/c.ts"]);
  });
});
