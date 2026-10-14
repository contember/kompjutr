import { expect } from "vitest";
import { concat } from "../../packages/git/src/common/bytes.js";
import {
  type GitServerOptions,
  maintainRepository,
  SqliteGitDatabase,
} from "../../packages/git/src/index.js";
import { FLUSH, pkt } from "../../packages/git/src/protocol/pktline.js";
import { bareServer, pushBytes, pushRequest } from "./bare-server.js";
import type { TestDatabase } from "./db.js";
import { GitFixture, slices } from "./git.js";
import { frames } from "./server-oracle.js";
import { runGit } from "./server-oracle-http.js";

export function firstYieldBarrier() {
  let reached = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  return {
    entered,
    release,
    async yieldNow() {
      if (!first) return;
      first = false;
      reached();
      await resumed;
    },
  };
}

export async function concurrentRepository(options: Partial<GitServerOptions> = {}) {
  const fixture = bareServer(options);
  const native = new GitFixture().init();
  try {
    native.write("file", "base");
    const base = native.commit("base");
    await fixture.store.packs.ingest(slices(native.packAll(), 8192));
    fixture.store.setRef("refs/heads/main", base);
    native.write("file", "left");
    const left = native.commit("left");
    native.git("branch", "left", left);
    native.git("reset", "--hard", base);
    native.write("file", "right");
    const right = native.commit("right");
    const pack = native.packAll();
    return {
      ...fixture,
      native,
      base,
      left,
      right,
      push(oldOid: string, newOid: string) {
        return pushRequest(pushBytes([{ oldOid, newOid, ref: "refs/heads/main" }], pack));
      },
    };
  } catch (error) {
    native.dispose();
    throw error;
  }
}

export function uploadRequest(oid: string): Request {
  return new Request("https://git.test/git-upload-pack", {
    method: "POST",
    headers: { "Content-Type": "application/x-git-upload-pack-request" },
    body: Uint8Array.from(concat([pkt(`want ${oid} multi_ack_detailed\n`), FLUSH, pkt("done\n")])),
  });
}

export function assertColdTip(
  db: TestDatabase,
  repoId: number,
  native: GitFixture,
  oid: string | null,
): void {
  const cold = new SqliteGitDatabase(db).openBareRepository(repoId);
  expect(cold.getRef("refs/heads/main")).toBe(oid);
  if (oid === null) return;
  const objects = native.git("rev-list", "--objects", oid).split("\n");
  for (const row of objects) {
    const objectOid = row.split(" ")[0];
    if (objectOid === undefined) throw new Error("missing native object OID");
    const type = native.git("cat-file", "-t", objectOid);
    const actual = cold.read(objectOid);
    expect(actual?.type).toBe(type);
    expect(Buffer.from(actual?.data ?? [])).toEqual(native.gitBinary("cat-file", type, objectOid));
  }
}

export async function verifyDownload(
  response: Response,
  oid: string,
  absent?: string,
): Promise<void> {
  expect(response.status).toBe(200);
  const native = new GitFixture().init();
  try {
    const bytes = Buffer.from(await response.arrayBuffer());
    await runGit(native.dir, ["index-pack", "--stdin"], frames(bytes).rest);
    native.git("update-ref", "refs/heads/main", oid);
    await runGit(native.dir, ["fsck", "--full"]);
    expect(native.git("rev-parse", "HEAD")).toBe(oid);
    if (absent !== undefined) expect(native.gitResult("cat-file", "-e", absent).status).not.toBe(0);
  } finally {
    native.dispose();
  }
}

export function finishMaintenance(
  database: SqliteGitDatabase,
  repoId: number,
  nowMs: number,
): void {
  for (let step = 0; step < 1000; step++) {
    if (maintainRepository(database, repoId, { nowMs }).status === "complete") return;
  }
  throw new Error("maintenance did not finish the small concurrency fixture");
}
