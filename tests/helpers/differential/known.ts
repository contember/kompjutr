// Divergences already understood. Each entry names why the two sides
// disagree; exploration counts a match instead of failing on it. An open
// defect stays here only until its fix lands with a regression scenario.

import type { Divergence } from "./run.js";

export interface KnownDivergence {
  id: string;
  reason: string;
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

export const KNOWN: KnownDivergence[] = [
  {
    id: "unborn-checkout-b",
    reason: "open: `checkout -b` on an unborn branch fails to resolve HEAD",
    matches: (d) => d.op.op === "checkoutNew" && /unknown revision: HEAD/.test(detail(d.kompjutr)),
  },
  {
    id: "message-cleanup",
    reason: "open: commit messages are stored without git's whitespace cleanup",
    matches: (d) => "message" in d.op && /[ \n]\n|\n\n$| $/.test(d.op.message),
  },
  {
    id: "detached-integration",
    reason: "intentional: integrations need a checked-out branch (git-support.md, Integration)",
    matches: (d) => /EDETACHED/.test(detail(d.kompjutr)),
  },
  {
    id: "checkout-carry",
    reason: "open: checkout drops or refuses staged changes git carries to the target",
    matches: (d) =>
      (d.op.op === "checkout" || d.op.op === "checkoutNew") &&
      (/would be overwritten by checkout/.test(detail(d.kompjutr)) || d.field === "index"),
  },
  {
    id: "reset-unmatched-path",
    reason: "open: path reset fails on a pathspec git accepts silently",
    matches: (d) => d.op.op === "reset" && /did not match any file/.test(detail(d.kompjutr)),
  },
  {
    id: "checkout-ancestor-ref",
    reason: "open: checkout of `<branch>~<n>` fails with EINVAL in a cloned repository",
    matches: (d) => d.op.op === "checkout" && /ref name is invalid/.test(detail(d.kompjutr)),
  },
  {
    id: "abort-resets-index",
    reason: "open: cherry-pick/revert/merge abort leaves staged changes git's reset --merge drops",
    matches: (d) => /(Abort|Skip)$/.test(d.op.op) && d.field === "index",
  },
  {
    id: "add-update-index",
    reason: "open: `add -u` stages only paths in HEAD, git stages every indexed path",
    matches: (d) =>
      (d.op.op === "addAll" && d.op.update === true && d.field === "index") ||
      (d.op.op === "commit" && d.op.all === true && (d.field === "refs" || d.field === "outcome")),
  },
  {
    id: "checkout-paths-unmatched",
    reason: "open: path checkout accepts a pathspec that matches nothing",
    matches: (d) => d.op.op === "checkoutPaths" && /did not match any file/.test(detail(d.git)),
  },
  {
    id: "operation-active",
    reason:
      "intentional: mutations other than resolution are refused while an integration is pending",
    matches: (d) => /EOPACTIVE/.test(detail(d.kompjutr)),
  },
  {
    id: "branch-rename-edges",
    reason: "open: branch rename refuses an unborn branch and a rename onto itself",
    matches: (d) => d.op.op === "branchRename" && /EBRANCHFAIL/.test(detail(d.kompjutr)),
  },
  {
    id: "replay-worktree",
    reason:
      "open: revert/cherry-pick trip on a missing worktree file, keep emptied directories, " +
      "and mishandle continue after an empty stop",
    matches: (d) =>
      (/^(revert|cherryPick)/.test(d.op.op) && /ENOENT/.test(detail(d.kompjutr))) ||
      (/^(revert|cherryPick)(Continue)?$/.test(d.op.op) &&
        (d.field === "worktree" || d.field === "outcome")),
  },
  {
    id: "merge-marker-label",
    reason: "open: conflict markers name the expanded ref instead of the name as given",
    matches: (d) => (d.op.op === "merge" || d.op.op === "pull") && d.field === "worktree",
  },
  {
    id: "push-tracking-after-rename",
    reason: "open: push of a renamed branch does not create its remote-tracking ref",
    matches: (d) => d.op.op === "push" && d.field === "refs",
  },
  {
    id: "amend-empty",
    reason: "open: amend accepts a result whose tree equals its parent's",
    matches: (d) => d.op.op === "commit" && d.op.amend === true && d.field === "outcome",
  },
  {
    id: "reset-unborn-head",
    reason: "open: `reset HEAD` on an unborn branch succeeds where git cannot resolve HEAD",
    matches: (d) => d.op.op === "reset" && d.op.ref === "HEAD" && d.field === "outcome",
  },
  {
    id: "checkout-paths-staged",
    reason: "open: path checkout refuses staged changes git overwrites",
    matches: (d) =>
      d.op.op === "checkoutPaths" && /would be overwritten by checkout/.test(detail(d.kompjutr)),
  },
  {
    id: "merge-without-renames",
    reason: "intentional: three-way integration detects no renames (git-support.md, git merge)",
    matches: (d) =>
      ["merge", "pull", "cherryPick", "revert", "rebase", "rebaseContinue"].includes(d.op.op) &&
      d.field === "outcome" &&
      outcomeKind(d.kompjutr) === "stopped" &&
      outcomeKind(d.git) === "clean",
  },
  {
    id: "rebase-unrelated",
    reason: "intentional: rebase refuses unrelated histories (git-support.md, git rebase)",
    matches: (d) => /EUNRELATED/.test(detail(d.kompjutr)),
  },
  {
    id: "abort-refuses-unmerged-entry",
    reason: "open: abort proceeds where git's reset --merge refuses an entry that is not uptodate",
    matches: (d) => /Abort$/.test(d.op.op) && /not uptodate/.test(detail(d.git)),
  },
  {
    id: "push-destination-after-rename",
    reason: "open: push of a renamed branch targets its moved upstream instead of its own name",
    matches: (d) => d.op.op === "push" && d.field === "outcome",
  },
  {
    id: "missing-worktree-path",
    reason: "open: add and forced checkout leak ENOENT/ENOTDIR for a staged path missing on disk",
    matches: (d) =>
      ["add", "addAll", "checkout"].includes(d.op.op) && /ENOENT|ENOTDIR/.test(detail(d.kompjutr)),
  },
  {
    id: "reset-ref-resolved-twice",
    reason: "open: argv reset resolves a relative ref again after moving HEAD",
    matches: (d) => d.op.op === "reset" && d.op.ref !== undefined && d.field === "index",
  },
  {
    id: "status-typechange",
    reason: "open: status reports a file/symlink type change as M instead of T",
    matches: (d) => d.field === "status" && /^1 .?T|^1 T/m.test(String(d.git)),
  },
  {
    id: "clean-empty-directories",
    reason: "open: clean -d fails on a tree of empty directories",
    matches: (d) => d.op.op === "clean" && /ENOTEMPTY/.test(detail(d.kompjutr)),
  },
];

export function knownDivergence(divergence: Divergence): KnownDivergence | undefined {
  return KNOWN.find((known) => known.matches(divergence));
}
