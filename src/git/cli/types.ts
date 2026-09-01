export const GIT_CLI_MAX_ARGV_ENTRIES = 256;
export const GIT_CLI_MAX_ENV_ENTRIES = 256;
export const GIT_CLI_MAX_LOG_COUNT = 50_000;
export const GIT_CLI_MAX_COMBINED_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface GitCliInput {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

export interface GitCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly truncated: boolean;
}

export interface GitCliRunOptions {
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly maxCombinedOutputBytes?: number;
  readonly discardStderr?: boolean;
  readonly logLimitHint?: number;
}

export interface GitCliRunner {
  runCli(input: GitCliInput, options?: GitCliRunOptions): Promise<GitCliResult>;
}

export interface ResolvedGitCliRunOptions {
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxCombinedOutputBytes: number;
  readonly discardStderr: boolean;
  readonly logLimitHint?: number;
}

export interface GitCliEnvironment {
  readonly GIT_AUTHOR_NAME?: string;
  readonly GIT_AUTHOR_EMAIL?: string;
  readonly GIT_COMMITTER_NAME?: string;
  readonly GIT_COMMITTER_EMAIL?: string;
}

export interface GitCliStatusCommand {
  readonly kind: "status";
  readonly format: "default" | "porcelain-v1" | "porcelain-v2" | "short";
  readonly branch?: boolean;
  readonly paths?: readonly string[];
}

export interface GitCliRevParseCommand {
  readonly kind: "rev-parse";
  readonly revision?: string;
  readonly verify?: boolean;
  readonly quiet?: boolean;
  readonly showToplevel?: boolean;
}

export interface GitCliBranchCommand {
  readonly kind: "branch";
  readonly action: "show-current" | "list";
}

export interface GitCliLsFilesCommand {
  readonly kind: "ls-files";
  readonly cached?: boolean;
  readonly others?: boolean;
  readonly excludeStandard?: boolean;
  readonly paths?: readonly string[];
}

export interface GitCliDiffCommand {
  readonly kind: "diff";
  readonly staged?: boolean;
  readonly ref?: string;
  readonly to?: string;
  readonly paths?: readonly string[];
  readonly context?: number;
}

export type GitCliLogFormat =
  | { readonly kind: "default" }
  | { readonly kind: "oneline" }
  | { readonly kind: "template"; readonly template: string };

export type GitCliRevision =
  | { readonly kind: "ref"; readonly ref: string }
  | { readonly kind: "range"; readonly left: string; readonly right: string };

export interface GitCliLogCommand {
  readonly kind: "log";
  readonly count?: number;
  readonly format: GitCliLogFormat;
  readonly revision?: GitCliRevision;
}

export interface GitCliRevListCommand {
  readonly kind: "rev-list";
  readonly left: string;
  readonly right: string;
}

export interface GitCliSymbolicRefCommand {
  readonly kind: "symbolic-ref";
  readonly ref: string;
}

export interface GitCliAddCommand {
  readonly kind: "add";
  readonly paths: readonly string[];
  readonly all?: boolean;
  readonly update?: boolean;
  readonly force?: boolean;
}

export interface GitCliCommitCommand {
  readonly kind: "commit";
  readonly message: string;
  readonly all?: boolean;
  readonly amend?: boolean;
  readonly allowEmpty?: boolean;
}

export interface GitCliRebaseCommand {
  readonly kind: "rebase";
  readonly action: "continue" | "abort";
}

export type ParsedGitCliCommand =
  | GitCliStatusCommand
  | GitCliRevParseCommand
  | GitCliBranchCommand
  | GitCliLsFilesCommand
  | GitCliDiffCommand
  | GitCliLogCommand
  | GitCliRevListCommand
  | GitCliSymbolicRefCommand
  | GitCliAddCommand
  | GitCliCommitCommand
  | GitCliRebaseCommand;

export interface GitCliInvocation<Command extends ParsedGitCliCommand = ParsedGitCliCommand> {
  readonly command: Command;
  readonly cwd: string;
  readonly env: GitCliEnvironment;
}

export type GitCliCommandHandler<Command extends ParsedGitCliCommand> = (
  invocation: GitCliInvocation<Command>,
  options: ResolvedGitCliRunOptions,
) => GitCliResult | Promise<GitCliResult>;

export interface GitCliHandlers {
  readonly status?: GitCliCommandHandler<GitCliStatusCommand>;
  readonly revParse?: GitCliCommandHandler<GitCliRevParseCommand>;
  readonly branch?: GitCliCommandHandler<GitCliBranchCommand>;
  readonly lsFiles?: GitCliCommandHandler<GitCliLsFilesCommand>;
  readonly diff?: GitCliCommandHandler<GitCliDiffCommand>;
  readonly log?: GitCliCommandHandler<GitCliLogCommand>;
  readonly revList?: GitCliCommandHandler<GitCliRevListCommand>;
  readonly symbolicRef?: GitCliCommandHandler<GitCliSymbolicRefCommand>;
  readonly add?: GitCliCommandHandler<GitCliAddCommand>;
  readonly commit?: GitCliCommandHandler<GitCliCommitCommand>;
  readonly rebase?: GitCliCommandHandler<GitCliRebaseCommand>;
}

export type GitCliParseResult =
  | { readonly ok: true; readonly invocation: GitCliInvocation }
  | { readonly ok: false; readonly result: GitCliResult };
