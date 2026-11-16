// Divergences already understood. Each entry names why the two sides
// disagree; exploration counts a match instead of failing on it. An open
// defect stays here only until its fix lands with a regression scenario.
//
// An entry matches only the op, outcome and preconditions its reason names,
// and only when every differing field is one it explains: a broad matcher
// would hide the next, unrelated divergence behind an old one.

import type { Op } from "./ops.js";
import type { Divergence } from "./run.js";

export interface KnownDivergence {
  id: string;
  reason: string;
  /** The snapshot fields (or `outcome`) this divergence can make differ. */
  fields: string[];
  matches(divergence: Divergence): boolean;
}

function outcomeKind(value: unknown): string {
  return typeof value === "object" && value !== null && "kind" in value ? String(value.kind) : "";
}

function detail(value: unknown): string {
  return typeof value === "object" && value !== null && "detail" in value
    ? String(value.detail)
    : "";
}

/** kompjutr failed with `code` where git did something else. */
function refused(d: Divergence, code: RegExp): boolean {
  return (
    d.field === "outcome" && outcomeKind(d.kompjutr) === "failed" && code.test(detail(d.kompjutr))
  );
}

function opIs(d: Divergence, ...kinds: Op["op"][]): boolean {
  return kinds.includes(d.op.op);
}

function playedBefore(d: Divergence, ...kinds: Op["op"][]): boolean {
  return d.before.some((op) => kinds.includes(op.op));
}

function worktreeOf(d: Divergence, side: "kompjutr" | "git"): string[] {
  const difference = d.differences.find((entry) => entry.field === "worktree");
  const value = difference?.[side];
  return Array.isArray(value) ? value.map((entry) => JSON.stringify(entry)) : [];
}

/** The worktrees differ only by directories kompjutr left behind. */
function onlyLeftoverDirectories(d: Divergence): boolean {
  const git = new Set(worktreeOf(d, "git"));
  const kompjutr = new Set(worktreeOf(d, "kompjutr"));
  const extra = [...kompjutr].filter((entry) => !git.has(entry));
  const missing = [...git].filter((entry) => !kompjutr.has(entry));
  return (
    extra.length > 0 &&
    missing.length === 0 &&
    extra.every((entry) => entry.includes('"type":"dir"'))
  );
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
  "commit",
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
      (refused(d, /would be overwritten by checkout/) || d.fields.includes("index")),
  },
  {
    id: "reset-unmatched-path",
    reason: "open: path reset fails on a pathspec git accepts silently",
    fields: ["outcome"],
    matches: (d) => opIs(d, "reset") && refused(d, /did not match any file/),
  },
  {
    id: "checkout-ancestor-ref",
    reason: "open: checkout of `<branch>~<n>` fails with EINVAL in a cloned repository",
    fields: ["outcome"],
    matches: (d) => opIs(d, "checkout") && refused(d, /ref name is invalid/),
  },
  {
    id: "abort-resets-index",
    reason: "open: cherry-pick/revert/merge abort leaves staged changes git's reset --merge drops",
    fields: ["index", "status", "worktree"],
    matches: (d) =>
      opIs(d, "mergeAbort", "cherryPickAbort", "cherryPickSkip", "revertAbort", "revertSkip") &&
      d.fields.includes("index"),
  },
  {
    id: "add-update-index",
    reason: "open: `add -u` stages only paths in HEAD, git stages every indexed path",
    fields: ["outcome", "refs", "head", "index", "status"],
    matches: (d) =>
      (d.op.op === "addAll" && d.op.update === true && d.fields.includes("index")) ||
      (d.op.op === "commit" && d.op.all === true),
  },
  {
    id: "checkout-paths-unmatched",
    reason: "open: path checkout accepts a pathspec that matches nothing",
    fields: ["outcome"],
    matches: (d) => opIs(d, "checkoutPaths") && /did not match any file/.test(detail(d.git)),
  },
  {
    id: "operation-active",
    reason:
      "intentional: the mutations git-support.md lists are refused while an integration is pending",
    fields: ["outcome"],
    matches: (d) =>
      (opIs(d, ...REFUSED_WHILE_PENDING) || (d.op.op === "reset" && d.op.hard !== true)) &&
      refused(d, /EOPACTIVE/),
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
        d.field === "worktree" &&
        onlyLeftoverDirectories(d)) ||
      (opIs(d, "revertContinue", "cherryPickContinue") &&
        d.field === "outcome" &&
        playedBefore(d, "revert", "cherryPick")),
  },
  {
    id: "merge-marker-label",
    reason: "open: conflict markers name the expanded ref instead of the name as given",
    fields: ["worktree"],
    // `>>>>>>> ` in hex: only conflicted files can differ.
    matches: (d) =>
      opIs(d, "merge", "pull") && worktreeOf(d, "git").some((e) => e.includes("3e3e3e3e3e3e3e20")),
  },
  {
    id: "push-tracking-after-rename",
    reason: "open: push of a renamed branch does not create its remote-tracking ref",
    fields: ["refs"],
    matches: (d) => opIs(d, "push") && playedBefore(d, "branchRename"),
  },
  {
    id: "amend-empty",
    reason: "open: amend accepts a result whose tree equals its parent's",
    fields: ["outcome"],
    matches: (d) =>
      d.op.op === "commit" &&
      d.op.amend === true &&
      outcomeKind(d.kompjutr) === "clean" &&
      outcomeKind(d.git) === "failed",
  },
  {
    id: "reset-unborn-head",
    reason: "open: `reset HEAD` on an unborn branch succeeds where git cannot resolve HEAD",
    fields: ["outcome"],
    matches: (d) =>
      d.op.op === "reset" &&
      d.op.ref === "HEAD" &&
      outcomeKind(d.kompjutr) === "clean" &&
      outcomeKind(d.git) === "failed",
  },
  {
    id: "checkout-paths-staged",
    reason: "open: path checkout refuses staged changes git overwrites",
    fields: ["outcome"],
    matches: (d) => opIs(d, "checkoutPaths") && refused(d, /would be overwritten by checkout/),
  },
  {
    id: "merge-without-renames",
    reason: "intentional: three-way integration detects no renames (git-support.md, git merge)",
    fields: ["outcome"],
    // Git can pair a rename only after a path was moved or removed.
    matches: (d) =>
      opIs(d, ...INTEGRATIONS, "rebaseContinue") &&
      playedBefore(d, "mv", "rm", "remove") &&
      d.field === "outcome" &&
      outcomeKind(d.kompjutr) === "stopped" &&
      outcomeKind(d.git) === "clean",
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
      /not uptodate/.test(detail(d.git)),
  },
  {
    id: "push-destination-after-rename",
    reason: "open: push of a renamed branch targets its moved upstream instead of its own name",
    fields: ["outcome"],
    matches: (d) => opIs(d, "push") && d.field === "outcome" && playedBefore(d, "branchRename"),
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
    id: "status-typechange",
    reason: "open: status reports a file/symlink type change as M instead of T",
    fields: ["status"],
    matches: (d) => d.field === "status" && /^1 (\.T|T\.)/m.test(String(d.git)),
  },
  {
    id: "clean-empty-directories",
    reason: "open: clean -d fails on a tree of empty directories",
    fields: ["outcome"],
    matches: (d) => opIs(d, "clean") && refused(d, /ENOTEMPTY/),
  },
];

export function knownDivergence(divergence: Divergence): KnownDivergence | undefined {
  return KNOWN.find(
    (known) =>
      known.matches(divergence) && divergence.fields.every((field) => known.fields.includes(field)),
  );
}
