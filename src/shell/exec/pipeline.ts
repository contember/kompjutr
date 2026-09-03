import type { PlannedPipeline } from "../plan/types.js";
import { expandArguments } from "./arguments.js";
import { type ByteStream, close, isAsyncByteStream, line } from "./bytes.js";
import { commandContext } from "./command-context.js";
import type { CommandResult } from "./context.js";
import type { PipelineEnvironment } from "./execution-types.js";
import {
  isFilesystemError,
  openRedirectionFiles,
  readWholeFile,
  resolveRedirections,
  routeStageOutput,
  UpstreamError,
} from "./redirections.js";
import type { HeldChunk, OutputDestination, ResolvedRedirections } from "./routing-types.js";
import {
  diagnosticsFor,
  releaseDiagnostics,
  rethrowAfterCommandCleanup,
  stageOutput,
} from "./stage-output.js";

export interface PipelineResult {
  readonly exitCode: number;
  readonly truncated: boolean;
  readonly terminateRun: boolean;
}

export async function runPipeline(
  pipeline: PlannedPipeline,
  env: PipelineEnvironment,
): Promise<PipelineResult> {
  let stream: ByteStream | null = env.inputs?.borrow() ?? null;
  const results: CommandResult[] = [];
  let settled = false;

  try {
    for (let index = 0; index < pipeline.commands.length; index++) {
      const planned = pipeline.commands[index];
      if (planned === undefined) continue;

      const command = env.commands.get(planned.name);
      if (command === undefined) {
        env.errors.writeBytes(line(`kompjutr: ${planned.name}: command not found`));
        await close(stream);
        settled = true;
        return {
          exitCode: 127,
          truncated: results.some(commandResultTruncated),
          terminateRun: false,
        };
      }

      const expanded = expandArguments(planned.args, env.fs, env.cwd, env.inputs?.env);
      const argv = expanded.argv;

      let redirections: ResolvedRedirections;
      try {
        redirections = resolveRedirections(planned, env.fs, env.cwd);
        await openRedirectionFiles(redirections, env.fs);
      } catch (error) {
        expanded.release();
        if (isFilesystemError(error)) {
          env.errors.writeBytes(line(`${planned.name}: ${error.message}`));
          return {
            exitCode: 1,
            truncated: results.some(commandResultTruncated),
            terminateRun: false,
          };
        }
        throw error;
      }

      if (redirections.stdin !== null) {
        const priorInput = stream;
        stream = null;
        let priorClosed = false;
        const closePrior = async (): Promise<void> => {
          if (priorClosed) return;
          priorClosed = true;
          await close(priorInput);
        };
        try {
          await closePrior();
          stream = readWholeFile(env.fs, redirections.stdin);
        } catch (error) {
          try {
            await closePrior();
          } finally {
            expanded.release();
          }
          throw error;
        }
      }

      const routedDiagnostics = new Map<OutputDestination, HeldChunk[]>();
      const stageInput = stream;
      const context = commandContext(
        planned,
        redirections,
        index === pipeline.commands.length - 1,
        pipeline.commands.length === 1,
        argv,
        stageInput,
        pipeline.limitHint,
        env,
        routedDiagnostics,
      );
      let produced: CommandResult;
      try {
        produced = await command(context);
      } catch (error) {
        rethrowAfterCommandCleanup(error, expanded, routedDiagnostics);
      }
      const releaseStage = isAsyncByteStreamOrNull(stageInput)
        ? async (): Promise<void> => {
            try {
              await close(stageInput);
            } finally {
              expanded.release();
            }
          }
        : (): void => {
            try {
              stageInput?.return?.();
            } finally {
              expanded.release();
            }
          };
      const output = stageOutput(
        produced.stdout,
        diagnosticsFor(routedDiagnostics, redirections.stdout),
        releaseStage,
        isAsyncByteStreamOrNull(stageInput),
      );
      results.push(produced);
      try {
        stream = await routeStageOutput(output, redirections, routedDiagnostics, env);
      } catch (error) {
        await close(output);
        releaseDiagnostics(routedDiagnostics);
        if (error instanceof UpstreamError) throw error.original;
        if (isFilesystemError(error)) {
          env.errors.writeBytes(line(`${planned.name}: ${error.message}`));
          return {
            exitCode: 1,
            truncated: results.some(commandResultTruncated),
            terminateRun: false,
          };
        }
        throw error;
      }
      if (produced.control?.kind === "exit") {
        await env.out.write(stream);
        settled = true;
        return {
          exitCode: produced.status(),
          truncated: results.some(commandResultTruncated),
          terminateRun: produced.control.terminateRun,
        };
      }
    }

    if (stream === null) {
      settled = true;
      return { exitCode: 0, truncated: false, terminateRun: false };
    }
    await env.out.write(stream);
    settled = true;

    // A pipeline's status is its last stage's, as in bash without pipefail.
    const last = results[results.length - 1];
    return {
      exitCode: last === undefined ? 0 : last.status(),
      truncated: results.some(commandResultTruncated),
      terminateRun: false,
    };
  } finally {
    if (!settled) await close(stream);
  }
}

function commandResultTruncated(result: CommandResult): boolean {
  return result.truncated?.() ?? false;
}

function isAsyncByteStreamOrNull(
  stream: ByteStream | null,
): stream is AsyncIterableIterator<Uint8Array, void, undefined> {
  return stream !== null && isAsyncByteStream(stream);
}
