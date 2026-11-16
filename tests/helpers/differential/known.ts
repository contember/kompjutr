// Divergences already understood. Each entry names why the two sides
// disagree; exploration counts a match instead of failing on it. An open
// defect stays here only until its fix lands with a regression scenario.

import type { Divergence } from "./run.js";

export interface KnownDivergence {
  id: string;
  reason: string;
  matches(divergence: Divergence): boolean;
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
    reason:
      "intentional: integrations need a checked-out branch (git-support.md, Integration)",
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
    matches: (d) => /Abort$/.test(d.op.op) && d.field === "index",
  },
  {
    id: "add-update-index",
    reason: "open: `add -u` stages only paths in HEAD, git stages every indexed path",
    matches: (d) => d.op.op === "addAll" && d.op.update === true && d.field === "index",
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
];

export function knownDivergence(divergence: Divergence): KnownDivergence | undefined {
  return KNOWN.find((known) => known.matches(divergence));
}
