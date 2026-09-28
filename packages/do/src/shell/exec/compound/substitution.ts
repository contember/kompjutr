// Command substitution. The list runs as a subshell of the expanding shell:
// a copy of its state, so `cd`, variables, and options do not leak back, and
// the run's operation and loop-iteration budgets. Its stdout is captured under
// the retained budget; exceeding it fails the run rather than truncating. Its
// stderr goes wherever the expanding command's stderr is bound at that point.

import type { Plan } from "../../plan/types.js";
import { encode } from "../bytes.js";
import { utf8Bytes } from "../utf8.js";
import type { Frame, Outcome, Runtime, Segments, Substituted, SubstitutionIO } from "./frame.js";
import { runList } from "./run.js";

const DECODER = new TextDecoder();
const NEWLINE = 0x0a;
const CANCELLED: Outcome = { status: 2, flow: null };

export async function runSubstitution(
  body: Plan,
  frame: Frame,
  io: SubstitutionIO,
  runtime: Runtime,
): Promise<Substituted> {
  const shell = frame.shell.clone(true);
  // Outside POSIX mode Bash does not pass `set -e` into a substitution.
  shell.options.errexit = false;
  const chunks: Uint8Array[] = [];
  const releases: Array<() => void> = [];
  const releaseChunks = (): void => {
    for (const release of releases) release();
    releases.length = 0;
  };
  try {
    const outcome = await capture(
      runBody(body, frame, shell, io, runtime),
      chunks,
      releases,
      runtime,
    );
    const { text, nul } = textOf(chunks);
    if (nul) {
      io.stderr.writeBytes(
        encode(
          `bash: line ${io.line}: warning: command substitution: ignored null byte in input\n`,
        ),
      );
    }
    releaseChunks();
    const release = runtime.fs.retained.retain(utf8Bytes(text), "command substitution");
    // Leaving a loop or the shell ends only the substitution.
    return { text, status: outcome.status, release };
  } finally {
    releaseChunks();
    shell.release();
  }
}

function runBody(
  body: Plan,
  frame: Frame,
  shell: Frame["shell"],
  io: SubstitutionIO,
  runtime: Runtime,
): Segments {
  return runList(
    body,
    {
      shell,
      io: {
        stdin: io.stdin,
        stderr: io.stderr,
        // Captured bytes are semantic input, never a terminal sink.
        stdoutLimit: () => Number.MAX_SAFE_INTEGER,
      },
      // `break` inside a substitution in a loop ends the substitution quietly.
      loops: frame.loops,
      errexitIgnored: false,
      substitutionLine: frame.substitutionLine ?? io.line,
    },
    runtime,
  );
}

async function capture(
  segments: Segments,
  chunks: Uint8Array[],
  releases: Array<() => void>,
  runtime: Runtime,
): Promise<Outcome> {
  let finished = false;
  try {
    for (;;) {
      const next = await segments.next();
      if (next.done === true) {
        finished = true;
        return next.value;
      }
      for await (const chunk of next.value) {
        if (chunk.length === 0) continue;
        releases.push(runtime.fs.retained.retain(chunk.length, "command substitution"));
        chunks.push(chunk);
      }
    }
  } finally {
    if (!finished) await segments.return(CANCELLED);
  }
}

/**
 * The captured text without NUL bytes, which Bash drops with a warning, and
 * without trailing newlines, which it strips after dropping them.
 */
function textOf(chunks: readonly Uint8Array[]): { text: string; nul: boolean } {
  let nul = false;
  let last = chunks.length - 1;
  let end = chunks[last]?.length ?? 0;
  for (;;) {
    const chunk = chunks[last];
    if (chunk === undefined) break;
    for (let byte = chunk[end - 1]; byte === NEWLINE || byte === 0; byte = chunk[end - 1]) {
      nul ||= byte === 0;
      end--;
    }
    if (end > 0) break;
    last--;
    end = chunks[last]?.length ?? 0;
  }

  let text = "";
  for (let index = 0; index <= last; index++) {
    const chunk = chunks[index];
    if (chunk === undefined) continue;
    const bytes = index === last ? chunk.subarray(0, end) : chunk;
    let start = 0;
    for (let at = bytes.indexOf(0); at !== -1; at = bytes.indexOf(0, start)) {
      nul = true;
      text += DECODER.decode(bytes.subarray(start, at), { stream: true });
      start = at + 1;
    }
    text += DECODER.decode(bytes.subarray(start), { stream: true });
  }
  text += DECODER.decode();
  return { text, nul };
}
