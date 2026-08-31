import { afterAll, describe, expect, it } from "vitest";
import { openRepository } from "../src/core/context.js";
import { checkoutTree } from "../src/core/ops/checkout.js";
import type { StatusEntry } from "../src/core/ops/kinds.js";
import {
  formatPorcelainV1,
  formatPorcelainV2,
  formatShort,
  status,
  statusReport,
} from "../src/core/ops/status.js";
import {
  STATUS_FORMAT_MAX_RECORDS,
  STATUS_FORMAT_MAX_RETAINED_BYTES,
  statusFormatOptions,
} from "../src/core/ops/status-format.js";
import type { StatusDetail } from "../src/core/ops/status-rows.js";
import { hashWorktreePath, indexEntryFor } from "../src/core/ops/worktree-io.js";
import { SqliteGitDatabase } from "../src/sqlite/store.js";
import { TestDatabase } from "./helpers/db.js";
import { GitFixture } from "./helpers/git.js";
import { importFixture } from "./helpers/import.js";
import { makeRepo, writeWorkFile } from "./helpers/workspace.js";

const fixtures: GitFixture[] = [];

afterAll(() => {
  for (const fixture of fixtures) fixture.dispose();
});

async function specialPathStatus() {
  const source = 'rename -> source".txt';
  const destination = "rename -> destination.txt";
  const fixture = new GitFixture().init();
  fixtures.push(fixture);
  fixture.write(source, "rename\n").commit("base");

  const workspace = makeRepo("/");
  await importFixture(fixture, workspace.repo.checkout);
  checkoutTree(workspace.repo, workspace.worktree, workspace.repo.headTree());
  workspace.tick(60_000);

  fixture.git("mv", "--", source, destination);
  workspace.worktree.rename(`/${source}`, `/${destination}`);
  workspace.repo.checkout.indexRemove(source);
  const renamed = hashWorktreePath(workspace.repo, workspace.worktree, destination);
  if (renamed === null) throw new Error("renamed path disappeared");
  workspace.repo.checkout.indexPut(indexEntryFor(destination, renamed));

  for (const path of [
    " leading.txt",
    "trailing.txt ",
    "line\nbreak.txt",
    "tab\tname.txt",
    "control\u0001name.txt",
    'quote"name.txt',
    "back\\slash.txt",
    "unicodé-𐀀.txt",
  ]) {
    fixture.write(path, "untracked\n");
    writeWorkFile(workspace, `/${path}`, "untracked\n");
  }

  return { fixture, workspace };
}

describe("status path formatting", () => {
  it("matches Git byte for byte in newline and NUL modes", async () => {
    const { fixture, workspace } = await specialPathStatus();
    const entries = status(workspace.repo, workspace.worktree);

    for (const quotePath of [true, false]) {
      fixture.git("config", "core.quotePath", String(quotePath));
      const options = { quotePath };
      const zeroOptions = { quotePath, zeroTerminate: true };

      expect(formatPorcelainV1(entries, options)).toBe(
        fixture.gitBinary("status", "--porcelain=v1", "--untracked-files=all").toString("utf8"),
      );
      expect(formatShort(entries, options)).toBe(
        fixture.gitBinary("status", "--short", "--untracked-files=all").toString("utf8"),
      );
      expect(formatPorcelainV2(entries, undefined, options)).toBe(
        fixture.gitBinary("status", "--porcelain=v2", "--untracked-files=all").toString("utf8"),
      );
      expect(formatPorcelainV1(entries, zeroOptions)).toBe(
        fixture
          .gitBinary("status", "--porcelain=v1", "--untracked-files=all", "-z")
          .toString("utf8"),
      );
      expect(formatShort(entries, zeroOptions)).toBe(
        fixture.gitBinary("status", "--short", "--untracked-files=all", "-z").toString("utf8"),
      );
      expect(formatPorcelainV2(entries, undefined, zeroOptions)).toBe(
        fixture
          .gitBinary("status", "--porcelain=v2", "--untracked-files=all", "-z")
          .toString("utf8"),
      );

      const report = statusReport(workspace.repo, workspace.worktree, { branch: true });
      expect(formatPorcelainV2(report.entries, report.branch, zeroOptions)).toBe(
        fixture
          .gitBinary("status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z")
          .toString("utf8"),
      );
    }
  });

  it("rejects NUL and lone surrogates before every formatter and framing mode", () => {
    const invalidPaths = ["nul\0path", "high\ud800path", "low\udc00path"];
    const ordinary = (path: string): StatusEntry => ({ path, index: " ", worktree: "?" });
    const detail = (path: string): StatusDetail => ({
      path,
      index: " ",
      worktree: "?",
      headMode: "000000",
      indexMode: "000000",
      worktreeMode: "100644",
      headOid: "0".repeat(40),
      indexOid: "0".repeat(40),
    });
    const rename = (path: string, originalPath: string): StatusEntry => ({
      path,
      originalPath,
      similarity: 100,
      index: "R",
      worktree: " ",
    });
    const renameDetail = (path: string, originalPath: string): StatusDetail => ({
      path,
      originalPath,
      similarity: 100,
      index: "R",
      worktree: " ",
      renamed: true,
      headMode: "100644",
      indexMode: "100644",
      worktreeMode: "100644",
      headOid: "1".repeat(40),
      indexOid: "1".repeat(40),
    });

    for (const invalid of invalidPaths) {
      for (const zeroTerminate of [false, true]) {
        const options = { zeroTerminate };
        for (const format of [
          () => formatPorcelainV1([ordinary(invalid)], options),
          () => formatShort([ordinary(invalid)], options),
          () => formatPorcelainV2([detail(invalid)], undefined, options),
          () => formatPorcelainV1([rename(invalid, "source")], options),
          () => formatPorcelainV1([rename("destination", invalid)], options),
          () => formatShort([rename(invalid, "source")], options),
          () => formatShort([rename("destination", invalid)], options),
          () => formatPorcelainV2([renameDetail(invalid, "source")], undefined, options),
          () => formatPorcelainV2([renameDetail("destination", invalid)], undefined, options),
        ]) {
          expect(format).toThrowError(expect.objectContaining({ code: "EINVAL" }));
        }
      }
    }

    const collapsed = ordinary("collapsed/");
    expect(formatPorcelainV1([collapsed])).toBe("?? collapsed/\n");
    expect(formatShort([collapsed], { zeroTerminate: true })).toBe("?? collapsed/\0");
    expect(formatPorcelainV2([detail("collapsed/")])).toBe("? collapsed/\n");
  });

  it("accepts the exact ordinary output budget and rejects its first excess", () => {
    const codeUnits = STATUS_FORMAT_MAX_RETAINED_BYTES / 2;
    const accepted = "a".repeat(codeUnits - 4);
    expect(formatPorcelainV1([{ path: accepted, index: " ", worktree: "?" }])).toHaveLength(
      codeUnits,
    );
    expect(() =>
      formatPorcelainV1([{ path: `${accepted}a`, index: " ", worktree: "?" }]),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });

  it("preflights rename and Unicode octal expansion at the exact budget", () => {
    const codeUnits = STATUS_FORMAT_MAX_RETAINED_BYTES / 2;
    const destination = "d".repeat(codeUnits - 9);
    const rename: StatusEntry = {
      path: destination,
      originalPath: "s",
      index: "R",
      worktree: " ",
    };
    expect(formatPorcelainV1([rename])).toHaveLength(codeUnits);
    expect(() => formatPorcelainV1([{ ...rename, path: `${destination}d` }])).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );

    const unicodeCount = Math.floor((codeUnits - 6) / 8);
    const suffix = "a".repeat(codeUnits - 6 - unicodeCount * 8);
    const unicode = `${"é".repeat(unicodeCount)}${suffix}`;
    expect(formatPorcelainV1([{ path: unicode, index: " ", worktree: "?" }])).toHaveLength(
      codeUnits,
    );
    expect(() =>
      formatPorcelainV1([{ path: `${unicode}a`, index: " ", worktree: "?" }]),
    ).toThrowError(expect.objectContaining({ code: "E2BIG" }));
  });

  it("preflights branch headers and record count at exact boundaries", () => {
    const codeUnits = STATUS_FORMAT_MAX_RETAINED_BYTES / 2;
    const fixed = "# branch.oid (initial)\n".length + "# branch.head \n".length;
    const head = "h".repeat(codeUnits - fixed);
    expect(formatPorcelainV2([], { oid: null, head })).toHaveLength(codeUnits);
    expect(() => formatPorcelainV2([], { oid: null, head: `${head}h` })).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );

    const entry: StatusEntry = { path: "a", index: " ", worktree: "?" };
    expect(formatPorcelainV1(Array(STATUS_FORMAT_MAX_RECORDS).fill(entry))).toHaveLength(
      STATUS_FORMAT_MAX_RECORDS * 5,
    );
    expect(() => formatPorcelainV1(Array(STATUS_FORMAT_MAX_RECORDS + 1).fill(entry))).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
  });
});

describe("status format configuration", () => {
  it("resolves former upstream ref, remote, and fetch first excesses", () => {
    const longRefWorkspace = makeRepo("/");
    const branch = "u".repeat(1_014);
    expect(`refs/heads/${branch}`).toHaveLength(1_025);
    longRefWorkspace.repo.store.configSet("branch.main.remote", ".");
    longRefWorkspace.repo.store.configSet("branch.main.merge", `refs/heads/${branch}`);
    expect(
      statusReport(longRefWorkspace.repo, longRefWorkspace.worktree, { branch: true }).branch,
    ).toMatchObject({ upstream: branch });

    const remoteWorkspace = makeRepo("/");
    const formerRemoteFirstExcess = "r".repeat(256);
    expect(formerRemoteFirstExcess).toHaveLength(256);
    remoteWorkspace.repo.store.configSet("branch.main.remote", formerRemoteFirstExcess);
    remoteWorkspace.repo.store.configSet("branch.main.merge", "refs/heads/upstream");
    remoteWorkspace.repo.store.configSet(
      `remote.${formerRemoteFirstExcess}.fetch`,
      `+refs/heads/*:refs/remotes/${formerRemoteFirstExcess}/*`,
    );
    expect(
      statusReport(remoteWorkspace.repo, remoteWorkspace.worktree, { branch: true }).branch,
    ).toMatchObject({ upstream: `${formerRemoteFirstExcess}/upstream` });

    const fetchWorkspace = makeRepo("/");
    const fetchPrefix = "+refs/heads/*:refs/remotes/";
    const fetchSuffix = "/*";
    const fetchRemote = "f".repeat(2_049 - fetchPrefix.length - fetchSuffix.length);
    const formerFetchFirstExcess = `${fetchPrefix}${fetchRemote}${fetchSuffix}`;
    fetchWorkspace.repo.store.configSet("branch.main.remote", fetchRemote);
    fetchWorkspace.repo.store.configSet("branch.main.merge", "refs/heads/upstream");
    fetchWorkspace.repo.store.configSet(`remote.${fetchRemote}.fetch`, formerFetchFirstExcess);
    expect(formerFetchFirstExcess).toHaveLength(2_049);
    expect(
      statusReport(fetchWorkspace.repo, fetchWorkspace.worktree, { branch: true }).branch,
    ).toMatchObject({ upstream: `${fetchRemote}/upstream` });

    const coldDatabase = new SqliteGitDatabase(new TestDatabase(fetchWorkspace.storage));
    const coldRepo = openRepository({ ...fetchWorkspace.context, database: coldDatabase });
    expect(statusReport(coldRepo, fetchWorkspace.worktree, { branch: true }).branch).toMatchObject({
      upstream: `${fetchRemote}/upstream`,
    });
  });

  it("resolves bounded Git booleans with explicit overrides taking precedence", () => {
    const workspace = makeRepo("/");

    expect(statusFormatOptions(workspace.repo)).toEqual({ quotePath: true, zeroTerminate: false });
    for (const value of ["true", "yes", "on", "1"]) {
      workspace.repo.store.configSet("core.quotePath", value);
      expect(statusFormatOptions(workspace.repo).quotePath).toBe(true);
    }
    for (const value of ["false", "no", "off", "0", ""]) {
      workspace.repo.store.configSet("core.quotePath", value);
      expect(statusFormatOptions(workspace.repo).quotePath).toBe(false);
    }

    workspace.repo.store.configSet("core.quotePath", "not-a-boolean");
    expect(() => statusFormatOptions(workspace.repo)).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(statusFormatOptions(workspace.repo, { quotePath: false, zeroTerminate: true })).toEqual({
      quotePath: false,
      zeroTerminate: true,
    });

    workspace.repo.store.configSet("core.quotePath", "x".repeat(17));
    expect(() => statusFormatOptions(workspace.repo)).toThrowError(
      expect.objectContaining({ code: "E2BIG" }),
    );
  });

  it("matches real Git numeric booleans and rejects padded values", () => {
    const workspace = makeRepo("/");
    const fixture = new GitFixture().init();
    fixtures.push(fixture);

    for (const value of ["2", "-1", "+2", "01", "0x1", "+0x1", "-0x1", "00", "-0"]) {
      fixture.git("config", "core.quotePath", value);
      workspace.repo.store.configSet("core.quotePath", value);
      expect(statusFormatOptions(workspace.repo).quotePath).toBe(
        fixture.git("config", "--bool", "core.quotePath") === "true",
      );
    }

    for (const value of [" true", "true "]) {
      fixture.git("config", "core.quotePath", value);
      workspace.repo.store.configSet("core.quotePath", value);
      expect(() => fixture.git("config", "--bool", "core.quotePath")).toThrow();
      expect(() => statusFormatOptions(workspace.repo)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
  });
});
