// Lists and compound commands.
//
// Status follows Bash: a list's is its last selected pipeline's, an `if`
// with no branch taken is 0, and a loop that ran no body is 0. `set -e`
// exits after a failed pipeline unless the failure is ignored — in an `if`
// condition, before a `&&` or `||`, or under `!` — and a group, `if`, or
// `for` that fails only through an ignored command does not exit either.

import type { Connector } from "../../parse/ast.js";
import type {
  Plan,
  PlannedCompound,
  PlannedFor,
  PlannedIf,
  PlannedPipeline,
} from "../../plan/types.js";
import { expandArguments, UnboundVariable } from "../arguments.js";
import { runPipeline } from "../pipeline.js";
import {
  EXIT,
  type Frame,
  fatalStatus,
  type Outcome,
  type Runtime,
  reportUnbound,
  type Segments,
} from "./frame.js";

export async function* runList(plan: Plan, frame: Frame, runtime: Runtime): Segments {
  let status = frame.shell.status;
  let previous: Connector | null = null;
  for (const step of plan.steps) {
    const selected =
      previous === null || previous === ";" || (previous === "&&" ? status === 0 : status !== 0);
    previous = step.connector;
    if (!selected) continue;

    const ignored =
      frame.errexitIgnored || step.negated || step.connector === "&&" || step.connector === "||";
    const stepFrame =
      ignored === frame.errexitIgnored ? frame : { ...frame, errexitIgnored: ignored };
    const outcome = yield* runPipeline(step.pipeline, stepFrame, runtime);
    status = step.negated && outcome.flow === null ? negate(outcome.status) : outcome.status;
    frame.shell.status = status;
    if (outcome.flow !== null) return { status, flow: outcome.flow };
    if (
      !ignored &&
      frame.shell.options.errexit &&
      status !== 0 &&
      !failsOnlyIgnored(step.pipeline)
    ) {
      return { status, flow: EXIT };
    }
  }
  return { status, flow: null };
}

export async function* runCompound(
  stage: PlannedCompound,
  frame: Frame,
  runtime: Runtime,
): Segments {
  switch (stage.kind) {
    case "group":
      return yield* runList(stage.body, frame, runtime);
    case "subshell":
      return yield* runSubshell(stage.body, frame, runtime);
    case "if":
      return yield* runIf(stage, frame, runtime);
    case "for":
      return yield* runFor(stage, frame, runtime);
  }
}

/** A copy of the shell, with no enclosing loops; its `exit` ends only the copy. */
async function* runSubshell(body: Plan, frame: Frame, runtime: Runtime): Segments {
  const shell = frame.shell.clone(true);
  try {
    const outcome = yield* runList(
      body,
      { shell, io: frame.io, loops: 0, errexitIgnored: frame.errexitIgnored },
      runtime,
    );
    return { status: outcome.status, flow: null };
  } finally {
    shell.release();
  }
}

async function* runIf(stage: PlannedIf, frame: Frame, runtime: Runtime): Segments {
  const conditionFrame = { ...frame, errexitIgnored: true };
  for (const clause of stage.clauses) {
    const condition = yield* runList(clause.condition, conditionFrame, runtime);
    if (condition.flow !== null) return condition;
    if (condition.status === 0) return yield* runList(clause.body, frame, runtime);
  }
  if (stage.otherwise !== null) return yield* runList(stage.otherwise, frame, runtime);
  return { status: 0, flow: null };
}

async function* runFor(stage: PlannedFor, frame: Frame, runtime: Runtime): Segments {
  let values: ReturnType<typeof expandArguments>;
  try {
    values = expandArguments(stage.words, runtime.fs, frame.shell.cwd, frame.shell.parameters());
  } catch (error) {
    if (!(error instanceof UnboundVariable)) throw error;
    reportUnbound(frame, stage.line, error);
    return { status: fatalStatus(frame), flow: EXIT };
  }

  try {
    const body = { ...frame, loops: frame.loops + 1 };
    let status = 0;
    for (const value of values.argv) {
      runtime.loops.charge();
      frame.shell.variables.set(stage.name, value);
      const outcome: Outcome = yield* runList(stage.body, body, runtime);
      status = outcome.status;
      const flow = outcome.flow;
      if (flow === null) continue;
      if (flow.kind === "exit") return outcome;
      if (flow.levels > 1) return { status, flow: { kind: flow.kind, levels: flow.levels - 1 } };
      if (flow.kind === "break") break;
    }
    return { status, flow: null };
  } finally {
    values.release();
  }
}

/**
 * A group, `if`, or `for` returns non-zero under `set -e` only when the
 * failure inside it was ignored; Bash does not exit for that. A subshell
 * and a multi-stage pipeline do exit.
 */
function failsOnlyIgnored(pipeline: PlannedPipeline): boolean {
  const [only, ...rest] = pipeline.commands;
  return (
    rest.length === 0 &&
    only !== undefined &&
    (only.kind === "group" || only.kind === "if" || only.kind === "for")
  );
}

function negate(status: number): number {
  return status === 0 ? 1 : 0;
}
