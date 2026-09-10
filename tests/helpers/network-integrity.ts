import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { concat, utf8 } from "../../packages/git/src/common/bytes.js";
import type { Repository } from "../../packages/git/src/ops/repository/repository.js";
import { pkt } from "../../packages/git/src/protocol/pktline.js";
import { GitFixture } from "./git.js";
import { startStubServer } from "./http-backend.js";

const execFileAsync = promisify(execFile);

export function selectedPack(fixture: GitFixture, omit: readonly string[] = []): Uint8Array {
  const excluded = new Set(omit);
  const oids = fixture
    .git("rev-list", "--objects", "--all")
    .split("\n")
    .map((line) => line.split(" ")[0])
    .filter((oid) => oid !== undefined && !excluded.has(oid));
  return execFileSync("git", ["pack-objects", "--stdout"], {
    cwd: fixture.dir,
    input: `${oids.join("\n")}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export type FrameEnding = "flush" | "eof" | "empty" | "unknown" | "progress";

export async function faultyRemote(
  fixture: GitFixture,
  options: {
    omit?: readonly string[];
    shallow?: string;
    filter?: boolean;
    ending?: FrameEnding;
  } = {},
) {
  const tip = fixture.git("rev-parse", "refs/heads/main");
  const refs = fixture.git("show-ref", "--dereference").split("\n");
  const advertisement = concat([
    pkt("# service=git-upload-pack\n"),
    utf8.encode("0000"),
    pkt(
      `${tip} HEAD\0side-band-64k shallow symref=HEAD:refs/heads/main${options.filter ? " filter" : ""}\n`,
    ),
    ...refs.map((line) => pkt(`${line}\n`)),
    utf8.encode("0000"),
  ]);
  const pack = selectedPack(fixture, options.omit);
  const parts =
    options.shallow === undefined ? [] : [pkt(`shallow ${options.shallow}\n`), utf8.encode("0000")];
  parts.push(pkt("NAK\n"));
  for (let offset = 0; offset < pack.length; offset += 16384) {
    parts.push(pkt(concat([new Uint8Array([1]), pack.subarray(offset, offset + 16384)])));
  }
  if (options.ending === "empty") parts.push(pkt(""));
  if (options.ending === "unknown") parts.push(pkt(new Uint8Array([4, 120])));
  if (options.ending === "progress")
    parts.push(pkt(concat([new Uint8Array([2]), utf8.encode("progress\n")])));
  if (options.ending !== "eof") parts.push(utf8.encode("0000"));
  const response = concat(parts);
  const server = await startStubServer((request, reply) => {
    reply.setHeader(
      "Content-Type",
      request.method === "POST"
        ? "application/x-git-upload-pack-result"
        : "application/x-git-upload-pack-advertisement",
    );
    if (request.method !== "POST") {
      reply.end(advertisement);
      return;
    }
    let requestBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      if (options.shallow !== undefined && !requestBody.includes("done\n")) {
        reply.end(concat([pkt(`shallow ${options.shallow}\n`), utf8.encode("0000")]));
      } else reply.end(response);
    });
  });
  return server;
}

export async function nativeClone(url: string, options: readonly string[] = []): Promise<boolean> {
  const target = new GitFixture();
  try {
    await execFileAsync("git", ["clone", ...options, url, "clone"], {
      cwd: target.dir,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
    return true;
  } catch {
    return false;
  } finally {
    target.dispose();
  }
}

export function publicationState(repo: Repository) {
  return {
    refs: repo.store.listRefs(),
    head: repo.head(),
    shallow: repo.shallow(),
    index: repo.checkout.indexEntries(),
  };
}
