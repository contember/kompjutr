// One pipeline stage, in two steps: `prepareStage` resolves the command and
// expands its words and redirections; `startStage` invokes it — a registry
// command, an executor builtin, or a compound body — and wraps its output for
// routing.

import type { PlannedCompound, PlannedStage } from "../plan/types.js";
import { type ExpandedArguments, expandArguments, UnboundVariable } from "./arguments.js";
import { type ByteStream, close, empty, encode, isAsyncByteStream, line } from "./bytes.js";
import { commandContext, destinationLimit, type StageLabel } from "./command-context.js";
import { type BuiltinOutcome, SHELL_BUILTINS } from "./compound/builtins.js";
import {
  EXIT,
  type Flow,
  type Frame,
  fatalStatus,
  type Runtime,
  reportUnbound,
  type StdinCursor,
} from "./compound/frame.js";
import { runRoutedCompound } from "./compound/routed.js";
import { StreamCursor } from "./compound/stdin.js";
import { type BoundedFs, type CommandContext, type CommandResult, result } from "./context.js";
import {
  isFilesystemError,
  openRedirectionFiles,
  readText,
  readWholeFile,
  redirectionDiagnostic,
  resolveRedirections,
} from "./redirections.js";
import type { HeldChunk, OutputDestination, ResolvedRedirections } from "./routing-types.js";
import { diagnosticsFor, rethrowAfterCommandCleanup, stageOutput } from "./stage-output.js";

type Runner = (context: CommandContext, frame: Frame) => BuiltinOutcome | Promise<BuiltinOutcome>;

type StageTarget =
  | { readonly kind: "command"; readonly runner: Runner }
  | { readonly kind: "compound"; readonly stage: PlannedCompound };

export interface StageSettlement {
  status(): number;
  truncated(): boolean;
  flow(): Flow | null;
  /** False for a compound whose body was closed before it finished. */
  ran(): boolean;
}

export interface PreparedStage {
  readonly label: StageLabel;
  readonly target: StageTarget;
  readonly expanded: ExpandedArguments;
  readonly redirections: ResolvedRedirections;
}

export type Preparation =
  | { readonly kind: "ready"; readonly stage: PreparedStage }
  /** The stage's shell ended before its command ran; `exit` when it ends the shell. */
  | { readonly kind: "failed"; readonly status: number; readonly exit: boolean }
  /** The whole pipeline ends now with this status. */
  | { readonly kind: "abort"; readonly status: number };

export interface StartedStage {
  readonly output: ByteStream;
  readonly routed: Map<OutputDestination, HeldChunk[]>;
  readonly settlement: StageSettlement;
}

const OPENING_WORDS = { subshell: "(", group: "{", if: "if", for: "for" } as const;

const NO_ARGUMENTS: ExpandedArguments = { argv: [], release: () => {} };

export async function prepareStage(
  planned: PlannedStage,
  frame: Frame,
  runtime: Runtime,
): Promise<Preparation> {
  const shell = frame.shell;
  const parameters = shell.parameters();
  let label: StageLabel;
  let target: StageTarget;
  let expanded = NO_ARGUMENTS;
  if (planned.kind !== "command") {
    label = { name: OPENING_WORDS[planned.kind], line: planned.line };
    target = { kind: "compound", stage: planned };
  } else {
    label = { name: planned.name, line: planned.line };
    target = { kind: "command", runner: runnerFor(planned.name, runtime) };
    try {
      expanded = expandArguments(planned.args, runtime.fs, shell.cwd, parameters);
    } catch (error) {
      if (!(error instanceof UnboundVariable)) throw error;
      // An unexpandable word ends the stage's shell.
      reportUnbound(frame, planned.line, error);
      return { kind: "failed", status: fatalStatus(frame), exit: true };
    }
  }

  try {
    const redirections = resolveRedirections(planned, runtime.fs, shell.cwd, parameters);
    await openRedirectionFiles(redirections, runtime.fs);
    return { kind: "ready", stage: { label, target, expanded, redirections } };
  } catch (error) {
    expanded.release();
    if (error instanceof UnboundVariable) {
      // A here-document that cannot expand fails its command, not the shell.
      reportUnbound(frame, planned.line, error);
      return { kind: "failed", status: fatalStatus(frame), exit: false };
    }
    if (isFilesystemError(error)) {
      frame.io.stderr.writeBytes(line(redirectionDiagnostic(error, label)));
      return { kind: "abort", status: 1 };
    }
    throw error;
  }
}

/** `< file` or here-text replaces the previous stage's output, which is closed first. */
export async function replaceInput(
  prior: ByteStream | null,
  stage: PreparedStage,
  fs: BoundedFs,
): Promise<ByteStream | null> {
  const stdin = stage.redirections.stdin;
  if (stdin === null) return prior;
  let priorClosed = false;
  const closePrior = async (): Promise<void> => {
    if (priorClosed) return;
    priorClosed = true;
    await close(prior);
  };
  try {
    await closePrior();
    return stdin.kind === "file" ? readWholeFile(fs, stdin.path) : readText(fs, stdin.text);
  } catch (error) {
    try {
      await closePrior();
    } finally {
      stage.expanded.release();
    }
    throw error;
  }
}

export async function startStage(
  stage: PreparedStage,
  input: ByteStream | null,
  position: { readonly first: boolean; readonly last: boolean },
  limitHint: number | null,
  frame: Frame,
  runtime: Runtime,
): Promise<StartedStage> {
  const { label, target, expanded, redirections } = stage;
  const routed = new Map<OutputDestination, HeldChunk[]>();
  let produced: CommandResult;
  let flow: () => Flow | null;
  let ran: () => boolean = () => true;
  let release: () => void | Promise<void>;
  let asyncRelease: boolean;

  if (target.kind === "command") {
    const context = commandContext(
      label,
      redirections,
      position.last,
      expanded.argv,
      input,
      limitHint,
      frame,
      runtime,
      routed,
    );
    let outcome: BuiltinOutcome;
    try {
      outcome = await target.runner(context, frame);
    } catch (error) {
      rethrowAfterCommandCleanup(error, expanded, routed);
    }
    produced = outcome.result;
    const stageFlow = outcome.flow;
    flow = () => stageFlow;
    release = releaseCommandStage(input, expanded);
    asyncRelease = input !== null && isAsyncByteStream(input);
  } else {
    const context = commandContext(
      label,
      redirections,
      position.last,
      [],
      null,
      null,
      frame,
      runtime,
      routed,
    );
    let cursor: StdinCursor | null = null;
    let owned: StreamCursor | null = null;
    if (position.first && redirections.stdin === null) {
      // The body borrows the shell's own stdin, one pipeline at a time.
      await close(input);
      cursor = frame.io.stdin;
    } else if (input !== null) {
      owned = new StreamCursor(input, runtime.fs.retained, redirections.stdin?.kind === "file");
      cursor = owned;
    }
    const limits = {
      stdout: () => destinationLimit(redirections.stdout, position.last, frame),
      stderr: () => destinationLimit(redirections.stderr, position.last, frame),
    };
    const run = runRoutedCompound(target.stage, context, limits, frame, cursor, runtime);
    produced = run.result;
    flow = () => run.outcome()?.flow ?? null;
    ran = () => run.outcome() !== null;
    release = async () => {
      await owned?.close();
    };
    asyncRelease = true;
  }

  const output = stageOutput(
    produced.stdout,
    diagnosticsFor(routed, redirections.stdout),
    release,
    asyncRelease,
  );
  return {
    output,
    routed,
    settlement: {
      status: () => produced.status(),
      truncated: () => produced.truncated?.() ?? false,
      flow,
      ran,
    },
  };
}

/** Registry commands report `exit` through `control`; executor builtins through a flow. */
function runnerFor(name: string, runtime: Runtime): Runner {
  const builtin = SHELL_BUILTINS.get(name);
  if (builtin !== undefined) return builtin;
  const command = runtime.commands.get(name);
  if (command === undefined) return notFound(name);
  return async (context) => {
    const produced = await command(context);
    const exits = produced.control?.kind === "exit" && produced.control.terminateRun;
    return { result: produced, flow: exits ? EXIT : null };
  };
}

/** Bash reports a missing command after binding the stage's redirections. */
function notFound(name: string): Runner {
  return (context) => {
    context.diagnostic(encode(`bash: line ${context.line}: ${name}: command not found\n`));
    return { result: result(empty(), 127), flow: null };
  };
}

function releaseCommandStage(
  input: ByteStream | null,
  expanded: ExpandedArguments,
): () => void | Promise<void> {
  if (input !== null && isAsyncByteStream(input)) {
    return async (): Promise<void> => {
      try {
        await close(input);
      } finally {
        expanded.release();
      }
    };
  }
  return (): void => {
    try {
      input?.return?.();
    } finally {
      expanded.release();
    }
  };
}
