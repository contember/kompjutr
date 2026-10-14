import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runGit } from "../../tests/helpers/server-oracle-http.js";

export type FixtureName = "medium" | "large";

const SHAPES = {
  medium: {
    commits: 128,
    files: 32,
    objects: 6400,
    head: "293ecdef09b63b9c0f5cbfc6eb0cd0343eee64f8",
  },
  large: {
    commits: 640,
    files: 160,
    objects: 113920,
    head: "582cf039ac884ab0c52ce92723564243d57cd338",
  },
};

function blob(commit: number, file: number): Buffer {
  if (file % 2 === 0) return Buffer.from(`${commit}:${file}:`.padEnd(1024, "x"));
  const bytes = Buffer.alloc(1024);
  for (let part = 0; part < 32; part++) {
    createHash("sha256")
      .update(`kompjutr-server-v1:${commit}:${file}:${part}`)
      .digest()
      .copy(bytes, part * 32);
  }
  return bytes;
}

export async function prepareServerFixture(name: FixtureName) {
  const shape = SHAPES[name];
  const directory = resolve(`bench/.fixtures/server-v1-${name}`);
  const manifestPath = join(directory, "server-fixture.json");
  await mkdir(directory, { recursive: true });
  let exists = false;
  try {
    await readFile(manifestPath);
    exists = true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (!exists) {
    await runGit(directory, ["init", "--bare", "-b", "main"]);
    const child = spawn("git", ["fast-import", "--quiet"], {
      cwd: directory,
      stdio: ["pipe", "ignore", "pipe"],
    });
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    const completion = once(child, "close");
    const write = async (data: string | Buffer) => {
      if (!child.stdin.write(data)) await once(child.stdin, "drain");
    };
    let mark = 1;
    for (let commit = 0; commit < shape.commits; commit++) {
      const first = mark;
      for (let file = 0; file < shape.files; file++) {
        await write(`blob\nmark :${mark++}\ndata 1024\n`);
        await write(blob(commit, file));
        await write("\n");
      }
      const message = `synthetic server v1 commit ${commit}\n`;
      await write(
        `commit refs/heads/main\ncommitter Fixture <fixture@example.com> ${1577836800 + commit} +0000\ndata ${Buffer.byteLength(message)}\n${message}deleteall\n`,
      );
      for (let file = 0; file < shape.files; file++) {
        await write(`M 100644 :${first + file} dir-${file % 16}/file-${file}.dat\n`);
      }
      await write("\n");
    }
    child.stdin.end("done\n");
    const [code] = await completion;
    if (code !== 0) throw new Error(`fast-import failed: ${Buffer.concat(errors)}`);
    await writeFile(manifestPath, JSON.stringify({ version: 1, name, ...shape }));
  }
  const head = (await runGit(directory, ["rev-parse", "refs/heads/main"])).stdout.toString().trim();
  const objectLines = (await runGit(directory, ["rev-list", "--objects", "--all"])).stdout
    .toString()
    .trim()
    .split("\n");
  const objects = objectLines.length;
  if (objects !== shape.objects || head !== shape.head) {
    throw new Error(`fixture identity mismatch: ${name} ${head} ${objects}`);
  }
  await runGit(directory, ["fsck", "--full", "--strict"]);
  return {
    name,
    version: 1,
    directory,
    head,
    objects,
    commits: shape.commits,
    files: shape.files,
    blobBytes: shape.commits * shape.files * 1024,
  };
}
