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
  readonly action: "show-current" | "list" | "create" | "delete" | "rename";
  readonly name?: string;
  readonly startPoint?: string;
  readonly oldName?: string;
  readonly newName?: string;
  readonly force?: boolean;
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
  readonly firstParent?: boolean;
  readonly paths?: readonly string[];
}

export interface GitCliShowCommand {
  readonly kind: "show";
  readonly ref?: string;
  readonly firstParent?: boolean;
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

export interface GitCliResetCommand {
  readonly kind: "reset";
  readonly mode: "mixed" | "hard";
  readonly ref?: string;
  readonly paths?: readonly string[];
}

export interface GitCliCheckoutCommand {
  readonly kind: "checkout";
  readonly action: "checkout" | "create";
  readonly ref?: string;
  readonly name?: string;
  readonly startPoint?: string;
  readonly paths?: readonly string[];
  readonly force?: boolean;
}

export interface GitCliSwitchCommand {
  readonly kind: "switch";
  readonly action: "switch" | "create";
  readonly name: string;
}

export interface GitCliRestoreCommand {
  readonly kind: "restore";
  readonly source?: string;
  readonly paths: readonly string[];
}

export interface GitCliRebaseCommand {
  readonly kind: "rebase";
  readonly action: "start" | "continue" | "skip" | "abort";
  readonly upstream?: string;
}

export interface GitCliMergeCommand {
  readonly kind: "merge";
  readonly action: "continue" | "abort";
}

export interface GitCliInitCommand {
  readonly kind: "init";
  readonly directory?: string;
  readonly defaultBranch?: string;
  readonly bare?: boolean;
}

export interface GitCliCloneCommand {
  readonly kind: "clone";
  readonly url: string;
  readonly directory?: string;
  readonly depth?: number;
  readonly singleBranch?: boolean;
  readonly noTags?: boolean;
  readonly ref?: string;
  readonly remote?: string;
  readonly filter?: "blob:none";
}

export interface GitCliRemoteCommand {
  readonly kind: "remote";
  readonly action: "list" | "add" | "remove" | "get-url" | "set-url";
  readonly verbose?: boolean;
  readonly name?: string;
  readonly url?: string;
}

export interface GitCliLsRemoteCommand {
  readonly kind: "ls-remote";
  readonly target?: string;
  readonly patterns: readonly string[];
}

export interface GitCliFetchRefspec {
  readonly source: string;
  readonly destination: string;
  readonly force?: boolean;
}

export interface GitCliFetchCommand {
  readonly kind: "fetch";
  readonly target?: string;
  readonly selector?: string;
  readonly refspecs?: readonly [GitCliFetchRefspec, ...GitCliFetchRefspec[]];
  readonly depth?: number;
  readonly deepen?: number;
  readonly unshallow?: boolean;
  readonly singleBranch?: boolean;
  readonly prune?: boolean;
  readonly tags?: boolean;
  readonly filter?: "blob:none";
}

export interface GitCliPullCommand {
  readonly kind: "pull";
  readonly remote?: string;
  readonly branch?: string;
  readonly rebase?: boolean;
  readonly fastForward?: boolean;
  readonly fastForwardOnly?: boolean;
}

export type GitCliPushRefspec =
  | { readonly source: string; readonly destination: string; readonly force?: boolean }
  | { readonly source: null; readonly destination: string; readonly force?: never };

export interface GitCliPushLease {
  readonly destination: string;
  readonly expected?: string | null;
  readonly tracking?: true;
}

export interface GitCliPushCommand {
  readonly kind: "push";
  readonly target?: string;
  readonly selector?: string;
  readonly refspecs?: readonly [GitCliPushRefspec, ...GitCliPushRefspec[]];
  readonly force?: boolean;
  readonly delete?: boolean;
  readonly atomic?: boolean;
  readonly leases: readonly GitCliPushLease[];
  readonly pushOptions: readonly string[];
}

export type ParsedGitCliCommand =
  | GitCliStatusCommand
  | GitCliRevParseCommand
  | GitCliBranchCommand
  | GitCliLsFilesCommand
  | GitCliDiffCommand
  | GitCliLogCommand
  | GitCliShowCommand
  | GitCliRevListCommand
  | GitCliSymbolicRefCommand
  | GitCliAddCommand
  | GitCliCommitCommand
  | GitCliResetCommand
  | GitCliCheckoutCommand
  | GitCliSwitchCommand
  | GitCliRestoreCommand
  | GitCliRebaseCommand
  | GitCliMergeCommand
  | GitCliInitCommand
  | GitCliCloneCommand
  | GitCliRemoteCommand
  | GitCliLsRemoteCommand
  | GitCliFetchCommand
  | GitCliPullCommand
  | GitCliPushCommand;

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
  readonly show?: GitCliCommandHandler<GitCliShowCommand>;
  readonly revList?: GitCliCommandHandler<GitCliRevListCommand>;
  readonly symbolicRef?: GitCliCommandHandler<GitCliSymbolicRefCommand>;
  readonly add?: GitCliCommandHandler<GitCliAddCommand>;
  readonly commit?: GitCliCommandHandler<GitCliCommitCommand>;
  readonly reset?: GitCliCommandHandler<GitCliResetCommand>;
  readonly checkout?: GitCliCommandHandler<GitCliCheckoutCommand>;
  readonly switch?: GitCliCommandHandler<GitCliSwitchCommand>;
  readonly restore?: GitCliCommandHandler<GitCliRestoreCommand>;
  readonly rebase?: GitCliCommandHandler<GitCliRebaseCommand>;
  readonly merge?: GitCliCommandHandler<GitCliMergeCommand>;
  readonly init?: GitCliCommandHandler<GitCliInitCommand>;
  readonly clone?: GitCliCommandHandler<GitCliCloneCommand>;
  readonly remote?: GitCliCommandHandler<GitCliRemoteCommand>;
  readonly lsRemote?: GitCliCommandHandler<GitCliLsRemoteCommand>;
  readonly fetch?: GitCliCommandHandler<GitCliFetchCommand>;
  readonly pull?: GitCliCommandHandler<GitCliPullCommand>;
  readonly push?: GitCliCommandHandler<GitCliPushCommand>;
}

export type GitCliParseResult =
  | { readonly ok: true; readonly invocation: GitCliInvocation }
  | { readonly ok: false; readonly result: GitCliResult };
