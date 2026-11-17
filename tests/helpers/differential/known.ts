// Divergences already understood. Each entry names why the two sides
// disagree; exploration counts a match instead of failing on it. An open
// defect stays here only until its fix lands with a regression scenario.
//
// An entry matches only the op, outcome and preconditions its reason names,
// and only when every differing field is one it explains: a broad matcher
// would hide the next, unrelated divergence behind an old one.

import type { DiskEntry } from "./disk.js";
import type { Op } from "./ops.js";
import type { Divergence } from "./run.js";

export interface KnownDivergence {
  id: string;
  reason: string;
  /** The snapshot fields (or `outcome`) this divergence can make differ. */
  fields: string[];
  matches(divergence: Divergence): boolean;
}

/** kompjutr failed with `code` where git did something else. */
function refused(d: Divergence, code: RegExp): boolean {
  const kompjutr = d.outcomes.kompjutr;
  return d.field === "outcome" && kompjutr.kind === "failed" && code.test(kompjutr.detail ?? "");
}

function opIs(d: Divergence, ...kinds: Op["op"][]): boolean {
  return kinds.includes(d.op.op);
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/** A path as status prints it, C-quoted when it holds special or non-ASCII bytes. */
function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  const bytes: number[] = [];
  const body = path.slice(1, -1);
  for (let index = 0; index < body.length; index++) {
    const char = body[index] ?? "";
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = body[++index] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(body.slice(index, index + 3), 8));
      index += 2;
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Paths whose index entry or worktree file the two sides disagree on. */
function differingPaths(d: Divergence): string[] {
  if (d.after === null) return [];
  const { kompjutr, git } = d.after;
  const paths: string[] = [];
  const leftIndex = new Set(kompjutr.index);
  const rightIndex = new Set(git.index);
  for (const entry of kompjutr.index) if (!rightIndex.has(entry)) paths.push(indexPath(entry));
  for (const entry of git.index) if (!leftIndex.has(entry)) paths.push(indexPath(entry));
  const files = (entries: DiskEntry[]): string[] =>
    entries.filter((entry) => entry.type !== "dir").map((entry) => JSON.stringify(entry));
  const leftFiles = new Set(files(kompjutr.worktree));
  const rightFiles = new Set(files(git.worktree));
  for (const entry of kompjutr.worktree.concat(git.worktree)) {
    if (entry.type === "dir") continue;
    const key = JSON.stringify(entry);
    if (!leftFiles.has(key) || !rightFiles.has(key)) paths.push(entry.path);
  }
  return paths;
}

/** The sides disagree on some path, and only on paths in `allowed`. */
function differsOnlyOn(d: Divergence, allowed: Set<string>): boolean {
  const paths = differingPaths(d);
  return paths.length > 0 && paths.every((path) => allowed.has(path));
}

/** Untracked paths in porcelain v2 `status`, a directory without its trailing slash. */
function untrackedPaths(status: string): string[] {
  return status
    .split("\n")
    .filter((line) => line.startsWith("? "))
    .map((line) => unquote(line.slice(2)).replace(/\/$/, ""));
}

/** The typed API's code, or the argv runner's rendering of it. */
const UNTRACKED_BLOCKERS =
  /^(?:ECHECKOUTFAIL|exit 128: fatal): untracked working tree files would be overwritten by checkout: (.+)$/s;

/** The blockers kompjutr's untracked refusal names, when it names them all. */
function untrackedBlockers(d: Divergence): string[] | undefined {
  const match = UNTRACKED_BLOCKERS.exec(d.outcomes.kompjutr.detail ?? "");
  if (d.field !== "outcome" || d.outcomes.kompjutr.kind !== "failed" || !match?.[1]) {
    return undefined;
  }
  // A truncated list hides blockers no matcher could check.
  if (/, and \d+ more$/.test(match[1])) return undefined;
  return match[1].split(", ");
}

/**
 * kompjutr refused naming blockers that were each untracked before the op,
 * or inside an untracked directory.
 */
function refusedOnlyForUntracked(d: Divergence): boolean {
  const named = untrackedBlockers(d);
  if (named === undefined) return false;
  const untracked = untrackedPaths(d.prior.status);
  return named.every((path) =>
    untracked.some((root) => path === root || path.startsWith(`${root}/`)),
  );
}

/** The path of an `ls-files -s` line. */
function indexPath(entry: string): string {
  return entry.slice(entry.indexOf("\t") + 1);
}

/** Paths staged as deleted before the op. */
function priorDeletions(d: Divergence): Set<string> {
  return new Set([...stagedDeletions(d.prior.status)].map(indexPath));
}

/** git refused naming only paths staged as deleted before the op; kompjutr wrote them. */
function gitRefusedOverDeletions(d: Divergence): boolean {
  const { kompjutr, git } = d.outcomes;
  if (d.field !== "outcome" || kompjutr.kind !== "clean" || git.kind !== "failed") return false;
  const detail = git.detail ?? "";
  if (!/would be overwritten by checkout/.test(detail)) return false;
  const named = detail
    .split("\n")
    .filter((line) => line.startsWith("\t"))
    .map((line) => unquote(line.slice(1)));
  const deleted = priorDeletions(d);
  return named.length > 0 && named.every((path) => deleted.has(path));
}

/** kompjutr refused over untracked files each staged as deleted before the op; git switched. */
function refusedOverDeletions(d: Divergence): boolean {
  const named = untrackedBlockers(d);
  if (d.outcomes.git.kind !== "clean" || named === undefined) return false;
  const deleted = priorDeletions(d);
  return named.every((path) => deleted.has(path));
}

/** HEAD's entries git's status reports as staged deletions, as `ls-files -s` lines. */
function stagedDeletions(status: string): Set<string> {
  const entries = new Set<string>();
  for (const line of status.split("\n")) {
    const fields = line.split(" ");
    if (fields[0] === "1" && fields[1]?.startsWith("D")) {
      entries.add(`${fields[3]} ${fields[6]} 0\t${unquote(fields.slice(8).join(" "))}`);
    }
  }
  return entries;
}

/**
 * kompjutr's index is git's plus target entries git kept staged as deleted,
 * and the sides differ on no other path.
 */
function restoredDeletionsOnly(d: Divergence): boolean {
  if (d.after === null) return false;
  const { kompjutr, git } = d.after;
  const left = new Set(kompjutr.index);
  const right = new Set(git.index);
  if (!git.index.every((entry) => left.has(entry))) return false;
  const deleted = stagedDeletions(git.status);
  const restored = kompjutr.index.filter((entry) => !right.has(entry));
  if (!restored.every((entry) => deleted.has(entry))) return false;
  return differsOnlyOn(d, new Set(restored.map(indexPath)));
}

const TRACKED_BLOCKERS = /^ECHECKOUTFAIL: local changes to (.+) would be overwritten by checkout$/s;

/**
 * kompjutr refused over files staged as new before the op, each below a
 * directory that an indexed sibling sorts between (`a` < `a!` < `a/`); git switched.
 */
function refusedOverNestedAdditions(d: Divergence): boolean {
  const match = TRACKED_BLOCKERS.exec(d.outcomes.kompjutr.detail ?? "");
  if (!refused(d, /^ECHECKOUTFAIL:/) || d.outcomes.git.kind !== "clean" || !match?.[1]) {
    return false;
  }
  const added = stagedAdditions(d.prior.status);
  const indexed = d.prior.index.map(indexPath);
  return match[1]
    .replace(/, and \d+ more$/, "")
    .split(", ")
    .every((path) => added.has(path) && hasSiblingBetween(path, indexed));
}

const SLASH = 0x2f;

/** Some indexed path sorts between an ancestor directory of `path` and its contents. */
function hasSiblingBetween(path: string, indexed: string[]): boolean {
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    const dir = path.slice(0, slash);
    if (indexed.some((other) => other.startsWith(dir) && other.charCodeAt(slash) < SLASH))
      return true;
  }
  return false;
}

/** Paths git's status reports as staged additions. */
function stagedAdditions(status: string): Set<string> {
  const paths = new Set<string>();
  for (const line of status.split("\n")) {
    const fields = line.split(" ");
    if (fields[0] === "1" && fields[1]?.startsWith("A")) {
      paths.add(unquote(fields.slice(8).join(" ")));
    }
  }
  return paths;
}

/** kompjutr's index holds a file where git kept the staged entries below it. */
function keptBelowTaken(d: Divergence): boolean {
  if (d.after === null) return false;
  const prior = new Set(d.prior.index);
  const left = new Set(d.after.kompjutr.index);
  const kept = d.after.git.index
    .filter((entry) => prior.has(entry) && !left.has(entry))
    .map(indexPath);
  const taken = d.after.kompjutr.index
    .map(indexPath)
    .filter((path) => kept.some((below) => below.startsWith(`${path}/`)));
  return taken.length > 0 && differsOnlyOn(d, new Set([...taken, ...kept]));
}

const INTEGRATIONS: Op["op"][] = ["merge", "pull", "cherryPick", "revert", "rebase"];

/** The mutations git-support.md lists as refused while an integration is pending. */
const REFUSED_WHILE_PENDING: Op["op"][] = [
  "branch",
  "branchDelete",
  "branchRename",
  "tag",
  "tagDelete",
  "checkout",
  "checkoutNew",
  "checkoutPaths",
  "clean",
  "fetch",
  "pull",
  "push",
  ...INTEGRATIONS,
];

export const KNOWN: KnownDivergence[] = [
  {
    id: "detached-integration",
    reason: "intentional: integrations need a checked-out branch (git-support.md, Integration)",
    fields: ["outcome"],
    matches: (d) => opIs(d, ...INTEGRATIONS) && refused(d, /EDETACHED/),
  },
  {
    id: "checkout-empty-index",
    reason:
      "intentional: an empty index is git's initial checkout, so init, fetch, updateRef and " +
      "checkout populate the worktree; an index emptied by `rm` looks the same, where git " +
      "keeps the deletions, refuses, or switches over files kompjutr sees as untracked " +
      "(git-support.md, checkout)",
    fields: ["outcome", "index", "status", "worktree"],
    matches: (d) =>
      opIs(d, "checkout", "checkoutNew") &&
      d.prior.head !== null &&
      d.prior.index.length === 0 &&
      (gitRefusedOverDeletions(d) ||
        refusedOverDeletions(d) ||
        (d.fields.includes("index") && restoredDeletionsOnly(d))),
  },
  {
    id: "checkout-kept-below-taken",
    reason:
      "intentional: git keeps staged entries below a file the target adds only when their " +
      "directory is gone or a sibling sorts between them, an artifact of its walk order; " +
      "kompjutr replaces clean ones and refuses over changed ones in every order " +
      "(git-support.md, checkout)",
    fields: ["outcome", "index", "status", "worktree"],
    matches: (d) =>
      opIs(d, "checkout", "checkoutNew") &&
      ((d.fields.includes("index") && keptBelowTaken(d)) || refusedOverNestedAdditions(d)),
  },
  {
    id: "operation-active",
    reason:
      "intentional: the mutations git-support.md lists are refused while an integration is pending",
    fields: ["outcome"],
    matches: (d) =>
      d.prior.operation !== null &&
      (opIs(d, ...REFUSED_WHILE_PENDING) ||
        (d.op.op === "reset" && d.op.hard !== true) ||
        (d.op.op === "commit" && d.prior.operation !== "merge")) &&
      // A typed call fails with the code (EMERGEACTIVE for a pending merge);
      // the argv runner, with git-style text, where commit's unmerged-index
      // check can answer before the operation check does.
      refused(
        d,
        /^(EOPACTIVE|EMERGEACTIVE):|^exit 128: .*(operation is already active|another operation is in progress|Committing is not possible because you have unmerged files)/s,
      ),
  },
  {
    id: "rebase-unrelated",
    reason: "intentional: rebase refuses unrelated histories (git-support.md, git rebase)",
    fields: ["outcome"],
    matches: (d) => opIs(d, "rebase") && refused(d, /EUNRELATED/),
  },
  {
    id: "rebase-merge-side-commits",
    reason:
      "intentional: rebase refuses a merge in the range whose other parents bring in commits " +
      "the upstream lacks; git replays them in its topological order (git-support.md, git rebase)",
    fields: ["outcome"],
    matches: (d) =>
      opIs(d, "rebase") && refused(d, /^EUNSUPPORTED: rebase selected range merges unreplayable/),
  },
  {
    id: "path-checkout-untracked-blocker",
    reason:
      "intentional: path checkout refuses to delete untracked content in the way; " +
      "git deletes it (git-support.md, git checkout)",
    fields: ["outcome"],
    matches: (d) =>
      opIs(d, "checkoutPaths") && d.outcomes.git.kind === "clean" && refusedOnlyForUntracked(d),
  },
];

export function knownDivergence(divergence: Divergence): KnownDivergence | undefined {
  return KNOWN.find(
    (known) =>
      known.matches(divergence) && divergence.fields.every((field) => known.fields.includes(field)),
  );
}
