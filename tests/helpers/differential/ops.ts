// The operation vocabulary of the differential tester. Every op is plain JSON,
// so a shrunk failing sequence prints as a repro that pastes straight into a
// regression test.

/** File bytes: readable text, or arbitrary bytes as hex. */
export type Content = { text: string } | { hex: string };

export type Op =
  // -- the working tree, written straight to disk on both sides
  | { op: "write"; path: string; content: Content; executable?: boolean }
  | { op: "remove"; path: string }
  | { op: "symlink"; path: string; target: string }
  // -- index and commits
  | { op: "add"; paths: string[] }
  | { op: "addAll"; update?: boolean }
  | { op: "rm"; paths: string[]; cached?: boolean; recursive?: boolean; force?: boolean }
  | { op: "mv"; from: string; to: string }
  | { op: "commit"; message: string; amend?: boolean; allowEmpty?: boolean; all?: boolean }
  | { op: "reset"; ref?: string; hard?: boolean; paths?: string[] }
  | { op: "clean"; directories?: boolean }
  // -- refs
  | { op: "branch"; name: string; startPoint?: string; force?: boolean }
  | { op: "branchDelete"; name: string; force?: boolean }
  | { op: "branchRename"; from: string; to: string }
  | { op: "checkout"; ref: string; force?: boolean }
  | { op: "checkoutNew"; name: string; startPoint?: string }
  | { op: "checkoutPaths"; ref: string; paths: string[] }
  | { op: "tag"; name: string; object?: string; force?: boolean }
  | { op: "tagDelete"; name: string }
  // -- integration
  | { op: "merge"; theirs: string; message: string; mode?: "no-ff" | "ff-only"; noCommit?: boolean }
  | { op: "mergeContinue"; message: string }
  | { op: "mergeAbort" }
  | { op: "cherryPick"; source: string }
  | { op: "cherryPickContinue" }
  | { op: "cherryPickSkip" }
  | { op: "cherryPickAbort" }
  | { op: "revert"; source: string }
  | { op: "revertContinue" }
  | { op: "revertSkip" }
  | { op: "revertAbort" }
  | { op: "rebase"; upstream: string }
  | { op: "rebaseContinue" }
  | { op: "rebaseSkip" }
  | { op: "rebaseAbort" }
  // -- network, only in a world started from a clone
  | { op: "fetch"; prune?: boolean }
  | { op: "push"; ref: string; force?: boolean; delete?: boolean }
  | { op: "pull"; message: string; mode?: "no-ff" | "ff-only" }
  /** A colleague commits on `branch` and pushes it to both origins. */
  | { op: "peerCommit"; branch: string; path: string; content: Content; message: string }
  // -- storage: kompjutr repacks loose objects, git runs `gc`
  | { op: "maintenance" }
  // -- the process lifecycle: kompjutr closes and reopens its database
  | { op: "reopen" };

export type OpKind = Op["op"];

/** How a world starts: an empty `init`, or a clone of a seeded origin. */
export type WorldStart = "init" | "clone";

export interface Scenario {
  start: WorldStart;
  ops: Op[];
}

export function contentBytes(content: Content): Buffer {
  return "text" in content ? Buffer.from(content.text, "utf8") : Buffer.from(content.hex, "hex");
}

/** One line per op, for failure reports. */
export function describeScenario(scenario: Scenario): string {
  const lines = scenario.ops.map((op, index) => `  ${index + 1}. ${JSON.stringify(op)}`);
  return [`start: ${scenario.start}`, ...lines].join("\n");
}
