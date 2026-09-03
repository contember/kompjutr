import type { BoundedFs, Command } from "./context.js";
import type { RunInputOwner } from "./input.js";
import type { Sink } from "./sink.js";

export interface PipelineEnvironment {
  readonly fs: BoundedFs;
  readonly cwd: string;
  readonly commands: ReadonlyMap<string, Command>;
  readonly out: Sink;
  readonly errors: Sink;
  readonly inputs: RunInputOwner | null;
  readonly currentStatus: number;
  chdir(path: string): void;
}
