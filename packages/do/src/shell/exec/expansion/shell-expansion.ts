// Expansion bound to one shell and one command: substitutions run against the
// shell's state and report through the stderr bound at that point, and the
// command remembers its last substitution's status, which is the status of a
// command that turns out to have no name.

import type { Plan } from "../../plan/types.js";
import type { DiagnosticPort, Frame, Runtime, StdinCursor } from "../compound/frame.js";
import type { BoundedFs } from "../context.js";
import type { Captured, Expansion, Parameters } from "./segments.js";

/** Shared by every expansion of one command. */
export interface SubstitutionStatus {
  last: number | null;
}

export class ShellExpansion implements Expansion {
  readonly fs: BoundedFs;

  constructor(
    private readonly frame: Frame,
    private readonly runtime: Runtime,
    private readonly io: {
      readonly stdin: StdinCursor | null;
      readonly stderr: DiagnosticPort;
      readonly line: number;
    },
    readonly status: SubstitutionStatus,
    readonly parameters: Parameters = frame.shell.parameters(),
  ) {
    this.fs = runtime.fs;
  }

  get cwd(): string {
    return this.frame.shell.cwd;
  }

  async substitute(body: Plan): Promise<Captured> {
    const substituted = await this.runtime.substitute(body, this.frame, this.io);
    this.frame.shell.status = substituted.status;
    this.status.last = substituted.status;
    return substituted;
  }

  /** The same command, its substitutions' stderr bound to `stderr`. */
  reporting(stderr: DiagnosticPort): ShellExpansion {
    return new ShellExpansion(
      this.frame,
      this.runtime,
      { ...this.io, stderr },
      this.status,
      this.parameters,
    );
  }

  /** The same command, reading parameters through `parameters`. */
  reading(parameters: Parameters): ShellExpansion {
    return new ShellExpansion(this.frame, this.runtime, this.io, this.status, parameters);
  }
}

/** Where `2>/dev/null` sends a substitution's diagnostics. */
export const DROPPED: DiagnosticPort = {
  writeBytes: () => {},
  write: async (stream) => {
    for await (const _chunk of stream) {
      // Pull to completion so lazy status and cleanup settle.
    }
  },
  limit: () => 0,
  discards: true,
};
