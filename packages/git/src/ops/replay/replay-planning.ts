import { isOid } from "../../common/bytes.js";
import { GitError } from "../../common/errors.js";
import { planIntegration } from "../integration/integration.js";
import type { Repository } from "../repository/repository.js";
import { readReplayCommit, requireBoundedRevision, resolveRevision } from "./replay-revision.js";
import type {
  BoundedRevisionLabels,
  FixedReplayStepInput,
  ReplayIncomingLabelStyle,
  ReplayInput,
  ReplayKind,
  ReplayLabels,
  ReplayPlan,
} from "./replay-types.js";

function requireMainline(
  kind: ReplayKind,
  parentCount: number,
  value: number | undefined,
): number | null {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new GitError("EINVAL", "replay mainline must be a positive safe integer");
  }
  if (parentCount === 0) {
    if (value !== undefined) {
      throw new GitError("EINVAL", `${kind} of a root commit does not accept a mainline parent`);
    }
    return null;
  }
  if (parentCount === 1) {
    if (value !== undefined && value !== 1) {
      throw new GitError("EINVAL", `replay mainline ${value} is outside the source parent range`);
    }
    return value ?? null;
  }
  if (value === undefined) {
    throw new GitError("EINVAL", `${kind} of a merge commit requires a mainline parent`);
  }
  if (value > parentCount) {
    throw new GitError("EINVAL", `replay mainline ${value} is outside the source parent range`);
  }
  return value;
}

function shortOid(oid: string | null): string {
  return oid === null ? "empty tree" : oid.slice(0, 12);
}

function sourceSubject(message: string): string {
  let start = 0;
  while (message.charCodeAt(start) === 0x0a) start++;
  const newline = message.indexOf("\n", start);
  return (newline < 0 ? message.slice(start) : message.slice(start, newline)).replace(/\r$/, "");
}

function incomingLabel(
  style: ReplayIncomingLabelStyle,
  kind: ReplayKind,
  sourceOid: string,
  selectedParentOid: string | null,
  sourceMessage: string,
): string {
  if (style === "source-subject") {
    return `${sourceOid.slice(0, 7)} (${sourceSubject(sourceMessage)})`;
  }
  if (style === "parent-of-source-subject") {
    return `parent of ${sourceOid.slice(0, 7)} (${sourceSubject(sourceMessage)})`;
  }
  return shortOid(kind === "cherry-pick" ? sourceOid : selectedParentOid);
}

/** Resolve one source commit and build its bounded integration delta without mutating state. */
export function planReplay(repo: Repository, input: ReplayInput): ReplayPlan {
  return planReplayInternal(repo, input);
}

function planReplayInternal(repo: Repository, input: ReplayInput): ReplayPlan {
  const revisionLabels: BoundedRevisionLabels = {
    input: "replay source",
    operation: "replay",
  };
  const sourceRevision = requireBoundedRevision(input.source, revisionLabels);
  if (!isOid(input.currentOid)) {
    throw new GitError("EINVAL", "replay current commit must be a full object id");
  }

  const currentCommit = readReplayCommit(repo, input.currentOid);
  const sourceOid = resolveRevision(repo, sourceRevision, revisionLabels);
  const sourceCommit = readReplayCommit(repo, sourceOid);
  const mainline = requireMainline(input.kind, sourceCommit.parent.length, input.mainline);
  const selectedParentOid =
    sourceCommit.parent.length === 0 ? null : (sourceCommit.parent[(mainline ?? 1) - 1] ?? null);
  if (sourceCommit.parent.length > 0 && selectedParentOid === null) {
    throw new GitError("ECORRUPT", "replay selected parent is missing");
  }
  const selectedParentTreeOid =
    selectedParentOid === null ? null : readReplayCommit(repo, selectedParentOid).tree;

  const baseTreeOid = input.kind === "cherry-pick" ? selectedParentTreeOid : sourceCommit.tree;
  const incomingTreeOid = input.kind === "cherry-pick" ? sourceCommit.tree : selectedParentTreeOid;
  const resolvedIncomingStyle = input.incomingLabelStyle ?? "tree";
  const labels: ReplayLabels = {
    current: input.text?.labels?.current ?? "HEAD",
    base:
      input.text?.labels?.base ??
      shortOid(input.kind === "cherry-pick" ? selectedParentOid : sourceOid),
    incoming:
      input.text?.labels?.incoming ??
      incomingLabel(
        resolvedIncomingStyle,
        input.kind,
        sourceOid,
        selectedParentOid,
        sourceCommit.message,
      ),
  };
  const integration = planIntegration(repo, {
    baseTreeOid,
    currentTreeOid: currentCommit.tree,
    incomingTreeOid,
    text: {
      ...input.text,
      labels,
    },
    limits: input.limits,
  });

  return {
    kind: input.kind,
    sourceOid,
    sourceCommit,
    sourceTreeOid: sourceCommit.tree,
    selectedParentOid,
    selectedParentTreeOid,
    mainline,
    currentOid: input.currentOid,
    currentCommit,
    currentTreeOid: currentCommit.tree,
    baseTreeOid,
    incomingTreeOid,
    labels,
    integration,
  };
}

/** Build one cherry-pick plan from immutable sequencer OIDs and verify its parent selection. */
export function planFixedReplayStep(repo: Repository, input: FixedReplayStepInput): ReplayPlan {
  return planFixedReplayStepInternal(repo, input);
}

function planFixedReplayStepInternal(repo: Repository, input: FixedReplayStepInput): ReplayPlan {
  if (!isOid(input.sourceOid) || !isOid(input.currentOid)) {
    throw new GitError("EINVAL", "rebase replay step requires full object ids");
  }
  if (input.selectedParentOid !== null && !isOid(input.selectedParentOid)) {
    throw new GitError("EINVAL", "rebase replay step selected parent is invalid");
  }
  const plan = planReplayInternal(repo, {
    kind: "cherry-pick",
    source: input.sourceOid,
    currentOid: input.currentOid,
    incomingLabelStyle: "source-subject",
    limits: input.limits,
  });
  if (
    plan.sourceOid !== input.sourceOid ||
    plan.selectedParentOid !== input.selectedParentOid ||
    plan.mainline !== null
  ) {
    throw new GitError("ECORRUPT", "rebase replay step differs from its authenticated queue");
  }
  return plan;
}
