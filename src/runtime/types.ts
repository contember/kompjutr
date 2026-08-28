import type { Filesystem } from "../fs/types.js";
import type { GitCliInput, GitCliResult } from "../git/cli/types.js";

export type { GitCliInput, GitCliResult } from "../git/cli/types.js";

/** The async mirror. Every function returns a Promise. */
export type Async<T> = {
  [K in keyof T]: T[K] extends (...arguments_: infer Arguments) => infer Result
    ? (...arguments_: Arguments) => Promise<Awaited<Result>>
    : T[K];
};

export type AsyncFilesystem = Async<Omit<Filesystem, "db" | "withReadScope">>;

export type ExitStatus = "completed" | "failed" | "cancelled";

export interface ProcessEvent {
  id: string;
  seq: number;
  name: "stdout" | "stderr" | "exit";
  chunk?: Uint8Array;
  code?: number;
}

export interface ProcessResult {
  status: ExitStatus;
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface ProcessHandle extends ReadableStream<ProcessEvent>, Disposable {
  readonly id: string;
  result(): Promise<ProcessResult>;
  kill(signal?: string): Promise<void>;
}

export interface ProcessExecOptions {
  id?: string;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array;
  timeoutMs?: number;
}

export interface ProcessHost {
  exec(command: string, options?: ProcessExecOptions): Promise<ProcessHandle>;
}

/** Exactly what a dynamically loaded Worker may reach. */
export interface RpcHost {
  readonly fs: AsyncFilesystem;
  readonly git: { cli(input: GitCliInput): Promise<GitCliResult> };
}
