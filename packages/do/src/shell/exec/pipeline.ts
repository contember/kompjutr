// One pipeline. Each stage's output stream is built in order and the last one
// is yielded to the consumer; nothing runs until something pulls.
//
// As in Bash, every stage of a multi-stage pipeline is its own shell: it runs
// on a copy of the shell state, so `cd x | cat` changes nothing and an `exit`
// or `break` there ends only that stage.

import type { PlannedPipeline, PlannedStage } from "../plan/types.js";
import { type ByteStream, close, line } from "./bytes.js";
import {
  EXIT,
  type Flow,
  type Frame,
  type PipelineOutcome,
  type Runtime,
  type Segments,
} from "./compound/frame.js";
import { PipeInput } from "./compound/stdin.js";
import {
  isFilesystemError,
  redirectionDiagnostic,
  routeStageOutput,
  UpstreamError,
} from "./redirections.js";
import { prepareStage, replaceInput, type StageSettlement, startStage } from "./stage.js";
import { releaseDiagnostics } from "./stage-output.js";

export async function* runPipeline(
  pipeline: PlannedPipeline,
  frame: Frame,
  runtime: Runtime,
): Segments<PipelineOutcome> {
  const stages = pipeline.commands;
  const [only] = stages;
  // An unrouted compound runs in place: its pipelines' output reaches the
  // consumer one pipeline at a time, as the enclosing list's would.
  if (stages.length === 1 && only !== undefined && only.kind !== "command") {
    if (only.redirections.length === 0) {
      return { ...(yield* runtime.compound(only, frame)), compoundRan: true };
    }
  }

  const multi = stages.length > 1;
  const settlements: StageSettlement[] = [];
  const copies: Frame[] = [];
  const finish = (status: number, flow: Flow | null, compoundRan = false): PipelineOutcome => {
    runtime.truncated ||= settlements.some((stage) => stage.truncated());
    return { status, flow, compoundRan };
  };
  let stream: ByteStream | null = null;
  let settled = false;

  try {
    for (let index = 0; index < stages.length; index++) {
      const planned = stages[index];
      if (planned === undefined) continue;
      const stageFrame = multi ? stageCopy(frame, planned) : frame;
      if (stageFrame !== frame) copies.push(stageFrame);

      // The shell's input is borrowed only after the first stage's substitutions have read theirs.
      const pipe = index === 0 ? null : new PipeInput(stream, runtime.fs.retained);
      const prepared = await prepareStage(planned, stageFrame, runtime, pipe ?? frame.io.stdin);
      stream = pipe === null ? (frame.io.stdin?.borrow() ?? null) : pipe.take();
      if (prepared.kind === "abort") return finish(prepared.status, null);
      if (prepared.kind === "failed") {
        if (!multi) {
          await close(stream);
          settled = true;
          return finish(prepared.status, prepared.exit ? EXIT : null);
        }
        stream = await failStage(stream, prepared.status, settlements);
        continue;
      }

      const stage = prepared.stage;
      const input = stream;
      stream = null;
      stream = await replaceInput(input, stage, runtime.fs);
      const started = await startStage(
        stage,
        stream,
        { first: index === 0, last: index === stages.length - 1 },
        pipeline.limitHint,
        stageFrame,
        runtime,
      );
      settlements.push(started.settlement);
      try {
        stream = await routeStageOutput(
          started.output,
          stage.redirections,
          started.routed,
          runtime.fs,
          stageFrame.io.stderr,
        );
      } catch (error) {
        await close(started.output);
        releaseDiagnostics(started.routed);
        if (error instanceof UpstreamError) throw error.original;
        if (isFilesystemError(error)) {
          stageFrame.io.stderr.writeBytes(line(redirectionDiagnostic(error, stage.label)));
          return finish(1, null);
        }
        throw error;
      }
    }

    if (stream === null) {
      settled = true;
      return finish(0, null);
    }
    yield stream;
    settled = true;
    const status = pipelineStatus(settlements, frame.shell.options.pipefail);
    const single = multi ? undefined : settlements[0];
    const compoundRan = only?.kind !== "command" && single?.ran() === true;
    return finish(status, single?.flow() ?? null, compoundRan);
  } finally {
    try {
      if (!settled) await close(stream);
    } finally {
      for (const copy of copies) copy.shell.release();
    }
  }
}

/** A compound stage and its body get no enclosing loops, as in Bash. */
function stageCopy(frame: Frame, planned: PlannedStage): Frame {
  const compound = planned.kind !== "command";
  return { ...frame, shell: frame.shell.clone(compound), loops: compound ? 0 : frame.loops };
}

/** A stage whose shell ended before its command ran: no output, a fixed status. */
async function failStage(
  input: ByteStream | null,
  status: number,
  settlements: StageSettlement[],
): Promise<ByteStream> {
  await close(input);
  settlements.push({
    status: () => status,
    truncated: () => false,
    flow: () => null,
    ran: () => false,
  });
  return (function* (): ByteStream {})();
}

/** The last stage's status, or with `pipefail` the rightmost non-zero one. */
function pipelineStatus(settlements: readonly StageSettlement[], pipefail: boolean): number {
  for (let index = settlements.length - 1; index >= 0; index--) {
    const status = settlements[index]?.status() ?? 0;
    if (!pipefail || status !== 0) return status;
  }
  return 0;
}
