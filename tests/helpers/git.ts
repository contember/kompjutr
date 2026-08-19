// Fixtures backed by the real git binary. Anything this package claims
// about pack layout, tree hashing or the wire protocol is checked against
// git itself rather than against another implementation of our own.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_AUTHOR_DATE: "2020-01-01T00:00:00+0000",
  GIT_COMMITTER_DATE: "2020-01-01T00:00:00+0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

export class GitFixture {
  readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? mkdtempSync(join(tmpdir(), "kompjutr-"));
  }

  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.dir, env: ENV, encoding: "utf8" }).trimEnd();
  }

  gitBinary(...args: string[]): Buffer {
    return execFileSync("git", args, { cwd: this.dir, env: ENV, maxBuffer: 1 << 30 });
  }

  init(defaultBranch = "main"): this {
    this.git("init", "-q", "-b", defaultBranch);
    this.git("config", "core.autocrlf", "false");
    return this;
  }

  write(path: string, content: string | Uint8Array): this {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return this;
  }

  /** A file with the executable bit set, so mode 100755 shows up in trees. */
  writeExecutable(path: string, content: string): this {
    this.write(path, content);
    chmodSync(join(this.dir, path), 0o755);
    return this;
  }

  chmod(path: string, mode: number): this {
    chmodSync(join(this.dir, path), mode);
    return this;
  }

  symlink(target: string, path: string): this {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    try {
      unlinkSync(full);
    } catch {
      // absent is the normal case
    }
    symlinkSync(target, full);
    return this;
  }

  remove(path: string): this {
    rmSync(join(this.dir, path), { recursive: true, force: true });
    return this;
  }

  commit(message: string): string {
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
    return this.git("rev-parse", "HEAD");
  }

  /** A packfile holding every object reachable from every ref. */
  packAll(): Uint8Array {
    const objects = execFileSync("git", ["rev-list", "--all", "--objects"], {
      cwd: this.dir,
      env: ENV,
      maxBuffer: 1 << 30,
      encoding: "utf8",
    });
    const oids = objects
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => `${line.split(" ")[0]}\n`)
      .join("");
    const pack = execFileSync("git", ["pack-objects", "--stdout", "-q"], {
      cwd: this.dir,
      env: ENV,
      input: oids,
      maxBuffer: 1 << 30,
    });
    return new Uint8Array(pack);
  }

  catFile(oid: string): Uint8Array {
    return new Uint8Array(this.gitBinary("cat-file", "-p", oid));
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Feed a buffer as an async iterable in fixed-size slices. */
export async function* slices(data: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < data.length; offset += size) {
    yield data.subarray(offset, offset + size);
  }
}
