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

/** Paths with a staged change against HEAD in porcelain v2 `status`. */
function stagedPaths(status: string): Set<string> {
  const paths = new Set<string>();
  for (const line of status.split("\n")) {
    const fields = line.split(" ");
    if (fields[0] === "1" && !fields[1]?.startsWith(".")) {
      paths.add(unquote(fields.slice(8).join(" ")));
    }
    if (fields[0] === "2" && !fields[1]?.startsWith(".")) {
      paths.add(unquote(fields.slice(9).join(" ").split("\t")[0] ?? ""));
    }
  }
  return paths;
}

/** Before the op, the index held a change against HEAD. */
function hadStagedChange(d: Divergence): boolean {
  return stagedPaths(d.prior.status).size > 0;
}

/** Unmerged paths in porcelain v2 `status`. */
function unmergedPaths(status: string): Set<string> {
  const paths = new Set<string>();
  for (const line of status.split("\n")) {
    const fields = line.split(" ");
    if (fields[0] === "u") paths.add(unquote(fields.slice(10).join(" ")));
  }
  return paths;
}

/** Paths whose index entry or worktree file the two sides disagree on. */
function differingPaths(d: Divergence): string[] {
  if (d.after === null) return [];
  const { kompjutr, git } = d.after;
  const paths: string[] = [];
  const indexPath = (entry: string): string => entry.slice(entry.indexOf("\t") + 1);
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

/** Paths the user staged during the pending integration, not the integration itself. */
function userStagedDuringIntegration(d: Divergence): Set<string> {
  const staged = stagedPaths(d.prior.status);
  for (let index = d.before.length - 1; index >= 0; index--) {
    const op = d.before[index];
    if (op === undefined || !INTEGRATIONS.includes(op.op)) continue;
    const stop = d.history[index + 1];
    if (stop === undefined) return new Set();
    const owned = new Set([...stagedPaths(stop.status), ...unmergedPaths(stop.status)]);
    return new Set([...staged].filter((path) => !owned.has(path)));
  }
  return new Set();
}

/** The last cherry-pick or revert before the op stopped with nothing to resolve. */
function stoppedEmpty(d: Divergence): boolean {
  for (let index = d.before.length - 1; index >= 0; index--) {
    const op = d.before[index];
    if (op?.op !== "cherryPick" && op?.op !== "revert") continue;
    const stopped = d.history[index + 1];
    return (
      stopped !== undefined &&
      stopped.operation !== null &&
      !/^u /m.test(stopped.status) &&
      stagedPaths(stopped.status).size === 0
    );
  }
  return false;
}

/** Before the op, an indexed path absent from HEAD had an unstaged change. */
function hadAddedPathChanged(d: Divergence): boolean {
  return /^1 A[MDT]/m.test(d.prior.status);
}

function worktrees(d: Divergence, normalize: (entry: DiskEntry) => DiskEntry): [string, string] {
  const show = (entries: DiskEntry[]): string => JSON.stringify(entries.map(normalize));
  return d.after === null
    ? ["", ""]
    : [show(d.after.kompjutr.worktree), show(d.after.git.worktree)];
}

/** The worktrees differ only by directories kompjutr left behind. */
function onlyLeftoverDirectories(d: Divergence): boolean {
  if (d.after === null) return false;
  const files = (entries: DiskEntry[]): string =>
    JSON.stringify(entries.filter((entry) => entry.type !== "dir"));
  const kompjutr = new Set(d.after.kompjutr.worktree.map((entry) => entry.path));
  return (
    d.after.kompjutr.worktree.length > d.after.git.worktree.length &&
    files(d.after.kompjutr.worktree) === files(d.after.git.worktree) &&
    d.after.git.worktree.every((entry) => kompjutr.has(entry.path))
  );
}

/** Conflict marker lines with their labels dropped. */
function unlabeled(entry: DiskEntry): DiskEntry {
  if (entry.content === undefined) return entry;
  const text = Buffer.from(entry.content, "hex").toString("latin1");
  const bare = text.replace(/^(<<<<<<<|>>>>>>>) .*$/gm, "$1");
  return { ...entry, content: Buffer.from(bare, "latin1").toString("hex") };
}

/** Git's stripspace changes this message: trailing blanks or blank edge lines. */
function needsCleanup(message: string): boolean {
  return /[ \t\r]\n|[ \t\r]$|\n\n$|^\n/.test(message);
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
    id: "unborn-checkout-b",
    reason: "open: `checkout -b` on an unborn branch fails to resolve HEAD",
    fields: ["outcome"],
    matches: (d) => opIs(d, "checkoutNew") && refused(d, /unknown revision: HEAD/),
  },
  {
    id: "message-cleanup",
    reason: "open: commit messages are stored without git's whitespace cleanup",
    fields: ["refs", "head"],
    matches: (d) => "message" in d.op && needsCleanup(d.op.message),
  },
  {
    id: "detached-integration",
    reason: "intentional: integrations need a checked-out branch (git-support.md, Integration)",
    fields: ["outcome"],
    matches: (d) => opIs(d, ...INTEGRATIONS) && refused(d, /EDETACHED/),
  },
  {
    id: "checkout-carry",
    reason: "open: checkout drops or refuses staged changes git carries to the target",
    fields: ["outcome", "index", "status", "worktree"],
    matches: (d) =>
      opIs(d, "checkout", "checkoutNew") &&
      ((hadStagedChange(d) && refused(d, /would be overwritten by checkout/)) ||
        (d.fields.includes("index") && differsOnlyOn(d, stagedPaths(d.prior.status)))),
  },
  {
    id: "reset-unmatched-path",
    reason: "open: path reset fails on a pathspec git accepts silently",
    fields: ["outcome"],
    matches: (d) => opIs(d, "reset") && refused(d, /did not match any file/),
  },
  {
    id: "checkout-ancestor-ref",
    reason: "open: checkout of `<ref>~<n>` fails with EINVAL",
    fields: ["outcome"],
    matches: (d) => opIs(d, "checkout") && refused(d, /ref name is invalid/),
  },
  {
    id: "abort-resets-index",
    reason: "open: cherry-pick/revert/merge abort leaves staged changes git's reset --merge drops",
    fields: ["index", "status", "worktree"],
    matches: (d) =>
      opIs(d, "mergeAbort", "cherryPickAbort", "cherryPickSkip", "revertAbort", "revertSkip") &&
      d.fields.includes("index") &&
      differsOnlyOn(d, userStagedDuringIntegration(d)),
  },
  {
    id: "add-update-index",
    reason: "open: `add -u` stages only paths in HEAD, git stages every indexed path",
    fields: ["outcome", "refs", "head", "index", "status"],
    matches: (d) =>
      d.prior.operation === null &&
      hadAddedPathChanged(d) &&
      ((d.op.op === "addAll" && d.op.update === true) ||
        (d.op.op === "commit" && d.op.all === true)),
  },
  {
    id: "checkout-paths-unmatched",
    reason: "open: path checkout accepts a pathspec that matches nothing",
    fields: ["outcome"],
    matches: (d) =>
      opIs(d, "checkoutPaths") &&
      d.field === "outcome" &&
      /did not match any file/.test(d.outcomes.git.detail ?? ""),
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
    id: "branch-rename-edges",
    reason: "open: branch rename refuses an unborn branch and a rename onto itself",
    fields: ["outcome"],
    matches: (d) => opIs(d, "branchRename") && refused(d, /EBRANCHFAIL/),
  },
  {
    id: "replay-worktree",
    reason:
      "open: revert/cherry-pick trip on a missing worktree file, keep emptied directories, " +
      "and mishandle continue after an empty stop",
    fields: ["outcome", "worktree"],
    matches: (d) =>
      (opIs(d, "revert", "cherryPick", "revertContinue", "cherryPickContinue") &&
        refused(d, /ENOENT/)) ||
      (opIs(d, ...INTEGRATIONS, "revertContinue", "cherryPickContinue", "rebaseContinue") &&
        onlyLeftoverDirectories(d)) ||
      (opIs(d, "revertContinue", "cherryPickContinue") && d.field === "outcome" && stoppedEmpty(d)),
  },
  {
    id: "merge-marker-label",
    reason: "open: conflict markers name the expanded ref instead of the name as given",
    fields: ["worktree"],
    matches: (d) => {
      if (!opIs(d, "merge", "pull")) return false;
      const [kompjutr, git] = worktrees(d, unlabeled);
      return kompjutr !== "" && kompjutr === git;
    },
  },
  {
    id: "push-after-rename",
    reason:
      "open: push of a renamed branch targets its moved upstream instead of its own name " +
      "and does not create its remote-tracking ref",
    fields: ["outcome", "refs", "originRefs"],
    matches: ({ op: push, before }) =>
      push.op === "push" && before.some((op) => op.op === "branchRename" && op.to === push.ref),
  },
  {
    id: "amend-empty",
    reason: "open: amend accepts a result whose tree equals its parent's",
    fields: ["outcome"],
    matches: (d) =>
      d.op.op === "commit" &&
      d.op.amend === true &&
      d.field === "outcome" &&
      d.outcomes.kompjutr.kind === "clean" &&
      d.outcomes.git.kind === "failed",
  },
  {
    id: "reset-unborn-head",
    reason: "open: `reset HEAD` on an unborn branch succeeds where git cannot resolve HEAD",
    fields: ["outcome"],
    matches: (d) =>
      d.op.op === "reset" &&
      d.op.ref === "HEAD" &&
      d.prior.head === null &&
      d.field === "outcome" &&
      d.outcomes.kompjutr.kind === "clean" &&
      d.outcomes.git.kind === "failed",
  },
  {
    id: "checkout-paths-staged",
    reason: "open: path checkout refuses staged changes git overwrites",
    fields: ["outcome"],
    matches: (d) => opIs(d, "checkoutPaths") && refused(d, /would be overwritten by checkout/),
  },
  {
    id: "rebase-unrelated",
    reason: "intentional: rebase refuses unrelated histories (git-support.md, git rebase)",
    fields: ["outcome"],
    matches: (d) => opIs(d, "rebase") && refused(d, /EUNRELATED/),
  },
  {
    id: "abort-refuses-unmerged-entry",
    reason: "open: abort proceeds where git's reset --merge refuses an entry that is not uptodate",
    fields: ["outcome"],
    matches: (d) =>
      opIs(d, "mergeAbort", "cherryPickAbort", "revertAbort") &&
      d.field === "outcome" &&
      /not uptodate/.test(d.outcomes.git.detail ?? ""),
  },
  {
    id: "missing-worktree-path",
    reason: "open: add and forced checkout leak ENOENT/ENOTDIR for a staged path missing on disk",
    fields: ["outcome"],
    matches: (d) => opIs(d, "add", "addAll", "checkout") && refused(d, /ENOENT|ENOTDIR/),
  },
  {
    id: "reset-ref-resolved-twice",
    reason: "open: argv reset resolves a relative ref again after moving HEAD",
    fields: ["index", "status", "worktree"],
    matches: (d) =>
      d.op.op === "reset" && /[~^]/.test(d.op.ref ?? "") && d.fields.includes("index"),
  },
  {
    id: "clean-empty-directories",
    reason: "open: clean -d fails on a tree of empty directories",
    fields: ["outcome"],
    matches: (d) => opIs(d, "clean") && refused(d, /ENOTEMPTY/),
  },
  {
    id: "branch-auto-upstream",
    reason: "open: a branch started from a remote-tracking ref gets no upstream config",
    fields: ["upstreams"],
    matches: ({ op, after }) =>
      (op.op === "branch" || op.op === "checkoutNew") &&
      (op.startPoint ?? "").startsWith("origin/") &&
      after?.kompjutr.upstreams.includes(`${op.name} - -`) === true,
  },
];

export function knownDivergence(divergence: Divergence): KnownDivergence | undefined {
  return KNOWN.find(
    (known) =>
      known.matches(divergence) && divergence.fields.every((field) => known.fields.includes(field)),
  );
}
