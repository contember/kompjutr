import { describe, expect, it } from "vitest";
import { createFilesystem } from "../../src/fs/filesystem.js";
import type { Filesystem } from "../../src/fs/types.js";
import type { ByteStream } from "../../src/shell/exec/bytes.js";
import { type Command, type RetainedBudget, result } from "../../src/shell/exec/context.js";
import { createShell } from "../../src/shell/index.js";
import { TestDatabase } from "../helpers/db.js";

const MIB = 1024 * 1024;
const FORMER_REDIRECT_BYTES_MAX = 96 * MIB;
const STREAM_BYTES = FORMER_REDIRECT_BYTES_MAX + 1;
const CHUNK = new Uint8Array(MIB).fill(0x5a);
interface Published {
  readonly path: string;
  readonly append: boolean;
  readonly size: number;
  readonly fullChunks: number;
  readonly finalByte: number;
}
interface StreamSink {
  readonly fs: Filesystem;
  readonly state: {
    calls: number;
    published: Published;
  };
}
function streamSink(failAfterDrain = false): StreamSink {
  const base = createFilesystem(new TestDatabase());
  base.mkdir("/repo");
  const state = {
    calls: 0,
    published: { path: "/repo/target", append: false, size: 3, fullChunks: 0, finalByte: 0 },
  };
  const fs: Filesystem = {
    ...base,
    writeFileStream(path, chunks, options): void {
      state.calls++;
      let size = 0;
      let fullChunks = 0;
      let finalByte = -1;
      for (const chunk of chunks) {
        size += chunk.length;
        if (chunk === CHUNK) fullChunks++;
        else if (chunk.length === 1) finalByte = chunk[0] ?? -1;
        else throw new Error("redirect yielded an unexpected chunk shape");
      }
      if (failAfterDrain) {
        throw Object.assign(new Error("injected late filesystem failure"), { code: "EIO" });
      }
      state.published = {
        path,
        append: options?.append === true,
        size,
        fullChunks,
        finalByte,
      };
    },
  };
  return { fs, state };
}
function producer(failAfterLimit: boolean, observe: (retained: RetainedBudget) => void): Command {
  return (context) => {
    observe(context.fs.retained);
    if (context.output.maxStdoutBytes < STREAM_BYTES) {
      throw new Error("redirect preflight refused the streamed total");
    }
    const stdout = (function* (): ByteStream {
      for (let index = 0; index < 96; index++) {
        const release = context.fs.retained.retain(CHUNK.length, "redirect pipeline chunk");
        try {
          yield CHUNK;
        } finally {
          release();
        }
      }
      const release = context.fs.retained.retain(1, "redirect pipeline chunk");
      try {
        yield CHUNK.subarray(0, 1);
      } finally {
        release();
      }
      if (failAfterLimit) throw new Error("injected late source failure");
    })();
    return result(stdout);
  };
}
function shellFor(sink: StreamSink, command: Command) {
  return createShell({
    fs: sink.fs,
    cwd: "/repo",
    commands: new Map([["produce", command]]),
    limits: {
      maxOutputBytes: 100,
      maxOperations: 10,
      readBudget: MIB,
      maxRetainedBytes: 128 * MIB,
    },
  });
}
describe("streamed shell redirects", () => {
  it("passes an exact total above the former 96 MiB limit to BoundedFs", async () => {
    const sink = streamSink();
    let retained: RetainedBudget | undefined;
    const shell = shellFor(
      sink,
      producer(false, (owner) => {
        retained = owner;
      }),
    );
    const run = await shell.run("produce > target");
    expect(run).toMatchObject({ exitCode: 0, stdout: "", operations: 1 });
    expect(sink.state.calls).toBe(1);
    expect(sink.state.published).toEqual({
      path: "/repo/target",
      append: false,
      size: STREAM_BYTES,
      fullChunks: 96,
      finalByte: 0x5a,
    });
    expect(run.peakRetainedBytes).toBe(MIB);
    expect(retained?.available).toBe(retained?.max);
  });
  it("leaves the target atomic and releases shell ownership after a late source failure", async () => {
    const sink = streamSink();
    let retained: RetainedBudget | undefined;
    const shell = shellFor(
      sink,
      producer(true, (owner) => {
        retained = owner;
      }),
    );
    await expect(shell.run("produce > target")).rejects.toThrow("injected late source failure");
    expect(sink.state.calls).toBe(1);
    expect(sink.state.published.size).toBe(3);
    expect(retained?.available).toBe(retained?.max);
  });
  it("leaves the target atomic and releases shell ownership after a late filesystem failure", async () => {
    const sink = streamSink(true);
    let retained: RetainedBudget | undefined;
    const shell = shellFor(
      sink,
      producer(false, (owner) => {
        retained = owner;
      }),
    );
    const run = await shell.run("produce > target");
    expect(run).toMatchObject({ exitCode: 1, stdout: "", operations: 1 });
    expect(run.stderr).toContain("injected late filesystem failure");
    expect(sink.state.calls).toBe(1);
    expect(sink.state.published.size).toBe(3);
    expect(retained?.available).toBe(retained?.max);
  });

  it("awaits an async source before one atomic redirect publication", async () => {
    const base = createFilesystem(new TestDatabase());
    base.mkdir("/repo");
    const delayed: Command = () =>
      result(
        (async function* (): ByteStream {
          await Promise.resolve();
          yield new TextEncoder().encode("first");
          await Promise.resolve();
          yield new TextEncoder().encode("second");
        })(),
      );
    const shell = createShell({
      fs: base,
      cwd: "/repo",
      commands: new Map([["delayed", delayed]]),
    });

    expect(await shell.run("delayed > target")).toMatchObject({ exitCode: 0, operations: 1 });
    expect(new TextDecoder().decode(base.readFile("/repo/target"))).toBe("firstsecond");
  });
});
