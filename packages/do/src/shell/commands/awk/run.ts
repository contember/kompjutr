// The program's life: BEGIN, the main loop over input records, and END, as
// one pull-based output stream. `exit` in BEGIN or a rule still runs END, as
// POSIX requires; a run time error flushes what was printed and exits 2.

import type { ByteStream } from "../../exec/bytes.js";
import { AwkFatalError, AwkRuntimeError, isStackOverflow } from "./errors.js";
import { ExitSignal, type Flow, type Step } from "./evaluate.js";
import { type InputSources, MainInput } from "./input.js";
import { Interpreter } from "./interpreter.js";
import type { Runtime } from "./runtime.js";
import { toNumber, toText } from "./values.js";

/** Flush inside a long-running statement once this much output waits. */
const STATEMENT_FLUSH = 64 * 1024;
/** Flush between records once this much output waits. */
const RECORD_FLUSH = 4096;

export interface RunHandle {
  readonly stdout: ByteStream;
  status(): number;
}

export function runProgram(
  runtime: Runtime,
  sources: InputSources,
  warn: (message: string) => void,
): RunHandle {
  const interpreter = new Interpreter(runtime);
  let status = 0;
  let records = 0;
  let fileRecords = 0;

  async function* phase(step: Step<Flow>): AsyncGenerator<Uint8Array, Flow, undefined> {
    try {
      for (;;) {
        const next = step.next();
        if (next.done === true) return next.value;
        if (runtime.output.size >= STATEMENT_FLUSH) yield runtime.output.take();
      }
    } catch (error) {
      if (error instanceof ExitSignal) return "exit";
      throw error;
    }
  }

  async function* main(): AsyncGenerator<Uint8Array, void, undefined> {
    const program = runtime.program;
    let exited = false;
    for (const block of program.begin) {
      if ((yield* phase(interpreter.execute(block))) === "exit") {
        exited = true;
        break;
      }
    }
    if (!exited && (program.rules.length > 0 || program.end.length > 0)) {
      const input = new MainInput(runtime, sources);
      let file = 0;
      try {
        for (;;) {
          const record = await input.next();
          if (record === null) break;
          if (input.files !== file) {
            file = input.files;
            fileRecords = 0;
          }
          records++;
          fileRecords++;
          runtime.setSpecial("NR", toNumber(runtime.special("NR")) + 1);
          runtime.setSpecial("FNR", toNumber(runtime.special("FNR")) + 1);
          runtime.fields.setRecord(record);
          const flow = yield* phase(interpreter.rules());
          if (flow === "exit") break;
          if (flow === "nextfile") await input.skipFile();
          if (runtime.output.size >= RECORD_FLUSH) yield runtime.output.take();
        }
      } finally {
        await input.skipFile();
      }
    }
    for (const block of program.end) {
      if ((yield* phase(interpreter.execute(block))) === "exit") break;
    }
    status = interpreter.exitStatus;
  }

  async function* stream(): ByteStream {
    try {
      try {
        yield* main();
      } catch (thrown) {
        const error = isStackOverflow(thrown)
          ? new AwkRuntimeError("expressions or calls nested too deeply for the stack")
          : thrown;
        if (error instanceof AwkRuntimeError) {
          if (runtime.output.size > 0) yield runtime.output.take();
          const file = toText(runtime.special("FILENAME"), runtime);
          warn(
            `run time error: ${error.message}\n\tFILENAME="${file}" FNR=${fileRecords} NR=${records}`,
          );
          status = 2;
        } else if (error instanceof AwkFatalError) {
          if (runtime.output.size > 0) yield runtime.output.take();
          warn(error.message);
          status = 2;
        } else {
          throw error;
        }
      }
      if (runtime.output.size > 0) yield runtime.output.take();
    } finally {
      runtime.release();
    }
  }

  return { stdout: stream(), status: () => status };
}
