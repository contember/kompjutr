import { GitError } from "../../core/errors.js";
import {
  GIT_CLI_MAX_COMBINED_OUTPUT_BYTES,
  GIT_CLI_MAX_LOG_COUNT,
  GIT_CLI_MAX_STDERR_BYTES,
  GIT_CLI_MAX_STDOUT_BYTES,
  type GitCliResult,
  type ResolvedGitCliRunOptions,
} from "./types.js";

const OPTION_KEYS = new Set([
  "maxStdoutBytes",
  "maxStderrBytes",
  "maxCombinedOutputBytes",
  "discardStderr",
  "logLimitHint",
]);

const USAGE = {
  status:
    "usage: git status [<options>] [--] [<pathspec>...]\n\n    -v, --[no-]verbose    be verbose\n    -s, --[no-]short      show status concisely\n    -b, --[no-]branch     show branch information\n    --[no-]show-stash     show stash information\n    --[no-]ahead-behind   compute full ahead/behind values\n    --[no-]porcelain[=<version>]\n                          machine-readable output\n    --[no-]long           show status in long format (default)\n    -z, --[no-]null       terminate entries with NUL\n    -u, --[no-]untracked-files[=<mode>]\n                          show untracked files, optional modes: all, normal, no. (Default: all)\n    --[no-]ignored[=<mode>]\n                          show ignored files, optional modes: traditional, matching, no. (Default: traditional)\n    --[no-]ignore-submodules[=<when>]\n                          ignore changes to submodules, optional when: all, dirty, untracked. (Default: all)\n    --[no-]column[=<style>]\n                          list untracked files in columns\n    --no-renames          do not detect renames\n    --renames             opposite of --no-renames\n    -M, --find-renames[=<n>]\n                          detect renames, optionally set similarity index\n\n",
  diff: "usage: git diff [<options>] [<commit>] [--] [<path>...]\n   or: git diff [<options>] --cached [--merge-base] [<commit>] [--] [<path>...]\n   or: git diff [<options>] [--merge-base] <commit> [<commit>...] <commit> [--] [<path>...]\n   or: git diff [<options>] <commit>...<commit> [--] [<path>...]\n   or: git diff [<options>] <blob> <blob>\n   or: git diff [<options>] --no-index [--] <path> <path> [<pathspec>...]\n\ncommon diff options:\n  -z            output diff-raw with lines terminated with NUL.\n  -p            output patch format.\n  -u            synonym for -p.\n  --patch-with-raw\n                output both a patch and the diff-raw format.\n  --stat        show diffstat instead of patch.\n  --numstat     show numeric diffstat instead of patch.\n  --patch-with-stat\n                output a patch and prepend its diffstat.\n  --name-only   show only names of changed files.\n  --name-status show names and status of changed files.\n  --full-index  show full object name on index lines.\n  --abbrev=<n>  abbreviate object names in diff-tree header and diff-raw.\n  -R            swap input file pairs.\n  -B            detect complete rewrites.\n  -M            detect renames.\n  -C            detect copies.\n  --find-copies-harder\n                try unchanged files as candidate for copy detection.\n  -l<n>         limit rename attempts up to <n> paths.\n  -O<file>      reorder diffs according to the <file>.\n  -S<string>    find filepair whose only one side contains the string.\n  --pickaxe-all\n                show all files diff when -S is used and hit is found.\n  -a  --text    treat all files as text.\n\n",
  "rev-list":
    "usage: git rev-list [<options>] <commit>... [--] [<path>...]\n\n  limiting output:\n    --max-count=<n>\n    --max-age=<epoch>\n    --min-age=<epoch>\n    --sparse\n    --no-merges\n    --min-parents=<n>\n    --no-min-parents\n    --max-parents=<n>\n    --no-max-parents\n    --remove-empty\n    --all\n    --branches\n    --tags\n    --remotes\n    --stdin\n    --exclude-hidden=[fetch|receive|uploadpack]\n    --quiet\n  ordering output:\n    --topo-order\n    --date-order\n    --reverse\n  formatting output:\n    --parents\n    --children\n    --objects | --objects-edge\n    --disk-usage[=human]\n    --unpacked\n    --header | --pretty\n    --[no-]object-names\n    --abbrev=<n> | --no-abbrev\n    --abbrev-commit\n    --left-right\n    --count\n    -z\n  special purpose:\n    --bisect\n    --bisect-vars\n    --bisect-all\n",
  "symbolic-ref":
    "usage: git symbolic-ref [-m <reason>] <name> <ref>\n   or: git symbolic-ref [-q] [--short] [--no-recurse] <name>\n   or: git symbolic-ref --delete [-q] <name>\n\n    -q, --[no-]quiet      suppress error message for non-symbolic (detached) refs\n    -d, --[no-]delete     delete symbolic ref\n    --[no-]short          shorten ref output\n    --[no-]recurse        recursively dereference (default)\n    -m <reason>           reason of the update\n\n",
  add: "usage: git add [<options>] [--] <pathspec>...\n\n    -n, --[no-]dry-run    dry run\n    -v, --[no-]verbose    be verbose\n\n    -i, --[no-]interactive\n                          interactive picking\n    -p, --[no-]patch      select hunks interactively\n    --[no-]auto-advance   auto advance to the next file when selecting hunks interactively\n    -U, --unified <n>     generate diffs with <n> lines context\n    --inter-hunk-context <n>\n                          show context between diff hunks up to the specified number of lines\n    -e, --[no-]edit       edit current diff and apply\n    -f, --[no-]force      allow adding otherwise ignored files\n    -u, --[no-]update     update tracked files\n    --[no-]renormalize    renormalize EOL of tracked files (implies -u)\n    -N, --[no-]intent-to-add\n                          record only the fact that the path will be added later\n    -A, --[no-]all        add changes from all tracked and untracked files\n    --[no-]ignore-removal ignore paths removed in the working tree (same as --no-all)\n    --[no-]refresh        don't add, only refresh the index\n    --[no-]ignore-errors  just skip files which cannot be added because of errors\n    --[no-]ignore-missing check if - even missing - files are ignored in dry run\n    --[no-]sparse         allow updating entries outside of the sparse-checkout cone\n    --[no-]chmod (+|-)x   override the executable bit of the listed files\n    --[no-]pathspec-from-file <file>\n                          read pathspec from file\n    --[no-]pathspec-file-nul\n                          with --pathspec-from-file, pathspec elements are separated with NUL character\n\n",
  commit:
    "usage: git commit [-a | --interactive | --patch] [-s] [-v] [-u[<mode>]] [--amend]\n                  [--dry-run] [(-c | -C | --squash) <commit> | --fixup [(amend|reword):]<commit>]\n                  [-F <file> | -m <msg>] [--reset-author] [--allow-empty]\n                  [--allow-empty-message] [--no-verify] [-e] [--author=<author>]\n                  [--date=<date>] [--cleanup=<mode>] [--[no-]status]\n                  [-i | -o] [--pathspec-from-file=<file> [--pathspec-file-nul]]\n                  [(--trailer <token>[(=|:)<value>])...] [-S[<keyid>]]\n                  [--] [<pathspec>...]\n\n    -q, --[no-]quiet      suppress summary after successful commit\n    -v, --[no-]verbose    show diff in commit message template\n\nCommit message options\n    -F, --[no-]file <file>\n                          read message from file\n    --[no-]author <author>\n                          override author for commit\n    --[no-]date <date>    override date for commit\n    -m, --[no-]message <message>\n                          commit message\n    -c, --[no-]reedit-message <commit>\n                          reuse and edit message from specified commit\n    -C, --[no-]reuse-message <commit>\n                          reuse message from specified commit\n    --[no-]fixup [(amend|reword):]commit\n                          use autosquash formatted message to fixup or amend/reword specified commit\n    --[no-]squash <commit>\n                          use autosquash formatted message to squash specified commit\n    --[no-]reset-author   the commit is authored by me now (used with -C/-c/--amend)\n    --[no-]trailer <trailer>\n                          add custom trailer(s)\n    -s, --[no-]signoff    add a Signed-off-by trailer\n    -t, --[no-]template <file>\n                          use specified template file\n    -e, --[no-]edit       force edit of commit\n    --[no-]cleanup <mode> how to strip spaces and #comments from message\n    --[no-]status         include status in commit message template\n    -S, --[no-]gpg-sign[=<key-id>]\n                          GPG sign commit\n\nCommit contents options\n    -a, --[no-]all        commit all changed files\n    -i, --[no-]include    add specified files to index for commit\n    --[no-]interactive    interactively add files\n    -p, --[no-]patch      interactively add changes\n    -U, --unified <n>     generate diffs with <n> lines context\n    --inter-hunk-context <n>\n                          show context between diff hunks up to the specified number of lines\n    -o, --[no-]only       commit only specified files\n    -n, --no-verify       bypass pre-commit and commit-msg hooks\n    --verify              opposite of --no-verify\n    --[no-]dry-run        show what would be committed\n    --[no-]short          show status concisely\n    --[no-]branch         show branch information\n    --[no-]ahead-behind   compute full ahead/behind values\n    --[no-]porcelain      machine-readable output\n    --[no-]long           show status in long format (default)\n    -z, --[no-]null       terminate entries with NUL\n    --[no-]amend          amend previous commit\n    --no-post-rewrite     bypass post-rewrite hook\n    --post-rewrite        opposite of --no-post-rewrite\n    -u, --[no-]untracked-files[=<mode>]\n                          show untracked files, optional modes: all, normal, no. (Default: all)\n    --[no-]pathspec-from-file <file>\n                          read pathspec from file\n    --[no-]pathspec-file-nul\n                          with --pathspec-from-file, pathspec elements are separated with NUL character\n\n",
  rebase:
    "usage: git rebase [-i] [options] [--exec <cmd>] [--onto <newbase> | --keep-base] [<upstream> [<branch>]]\n   or: git rebase [-i] [options] [--exec <cmd>] [--onto <newbase>] --root [<branch>]\n   or: git rebase --continue | --abort | --skip | --edit-todo\n\n    --[no-]onto <revision>\n                          rebase onto given branch instead of upstream\n    --[no-]keep-base      use the merge-base of upstream and branch as the current base\n    --no-verify           allow pre-rebase hook to run\n    --verify              opposite of --no-verify\n    -q, --[no-]quiet      be quiet. implies --no-stat\n    -v, --[no-]verbose    display a diffstat of what changed upstream\n    -n, --no-stat         do not show diffstat of what changed upstream\n    --stat                opposite of --no-stat\n    --[no-]trailer <trailer>\n                          add custom trailer(s)\n    --[no-]signoff        add a Signed-off-by trailer to each commit\n    --[no-]committer-date-is-author-date\n                          make committer date match author date\n    --[no-]reset-author-date\n                          ignore author date and use current date\n    -C <n>                passed to 'git apply'\n    --[no-]ignore-whitespace\n                          ignore changes in whitespace\n    --[no-]whitespace <action>\n                          passed to 'git apply'\n    -f, --[no-]force-rebase\n                          cherry-pick all commits, even if unchanged\n    --no-ff               cherry-pick all commits, even if unchanged\n    --ff                  opposite of --no-ff\n    --continue            continue\n    --skip                skip current patch and continue\n    --abort               abort and check out the original branch\n    --quit                abort but keep HEAD where it is\n    --edit-todo           edit the todo list during an interactive rebase\n    --show-current-patch  show the patch file being applied or merged\n    --apply               use apply strategies to rebase\n    -m, --merge           use merging strategies to rebase\n    -i, --interactive     let the user edit the list of commits to rebase\n    --[no-]rerere-autoupdate\n                          update the index with reused conflict resolution if possible\n    --empty (drop|keep|stop)\n                          how to handle commits that become empty\n    --[no-]autosquash     move commits that begin with squash!/fixup! under -i\n    --[no-]update-refs    update branches that point to commits that are being rebased\n    -S, --[no-]gpg-sign[=<key-id>]\n                          GPG-sign commits\n    --[no-]autostash      automatically stash/stash pop before and after\n    -x, --[no-]exec <exec>\n                          add exec lines after each commit of the editable list\n    -r, --[no-]rebase-merges[=<mode>]\n                          try to rebase merges instead of skipping them\n    --[no-]fork-point     use 'merge-base --fork-point' to refine upstream\n    -s, --[no-]strategy <strategy>\n                          use the given merge strategy\n    -X, --[no-]strategy-option <option>\n                          pass the argument through to the merge strategy\n    --[no-]root           rebase all reachable commits up to the root(s)\n    --[no-]reschedule-failed-exec\n                          automatically re-schedule any `exec` that fails\n    --[no-]reapply-cherry-picks\n                          apply all changes, even those already present upstream\n\n",
};

const PUSH_REFUSAL =
  "fatal: No configured push destination.\n" +
  "Either specify the URL from the command-line or configure a remote repository using\n" +
  "\n" +
  "    git remote add <name> <url>\n" +
  "\n" +
  "and then push using the remote name\n" +
  "\n" +
  "    git push <name>\n";

export type GitCliUsageCommand = keyof typeof USAGE;

export function gitCliResult(stdout: string, stderr: string, exitCode: number): GitCliResult {
  validateResultString(stdout, "stdout");
  validateResultString(stderr, "stderr");
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new GitError("EINVAL", "git CLI exit code must be a safe integer from 0 through 255");
  }
  return { stdout, stderr, exitCode };
}

export function gitCliUsageFailure(command: GitCliUsageCommand, detail: string): GitCliResult {
  return gitCliResult("", `error: ${detail}\n${USAGE[command]}`, 129);
}

export function gitCliUnknownOptionFailure(
  command: GitCliUsageCommand,
  option: string,
): GitCliResult {
  if (command === "rev-list") return gitCliResult("", USAGE[command], 129);
  if (command === "diff") {
    return gitCliResult("", `error: invalid option: ${option}\n${USAGE[command]}`, 129);
  }
  const label = option.startsWith("--") ? option.slice(2) : option.slice(1);
  return gitCliResult("", `error: unknown option \`${label}'\n${USAGE[command]}`, 129);
}

export function gitCliCommitMessageRequired(): GitCliResult {
  return gitCliResult("", "error: switch `m' requires a value\n", 129);
}

export function gitCliLogFailure(detail: string): GitCliResult {
  return gitCliResult("", `fatal: ${detail}\n`, 128);
}

export function gitCliUnknownCommand(command: string | undefined): GitCliResult {
  if (command === undefined) return gitCliResult("", "git: no command specified\n", 1);
  return gitCliResult("", `git: '${command}' is not a git command. See 'git --help'.\n`, 1);
}

export function gitCliNetworkRefusal(command: string): GitCliResult {
  if (command === "push") return gitCliResult("", PUSH_REFUSAL, 128);
  return gitCliResult("", `fatal: network command '${command}' is not supported\n`, 128);
}

export function resolveGitCliRunOptions(value: unknown): ResolvedGitCliRunOptions {
  if (value === undefined) {
    return {
      maxStdoutBytes: GIT_CLI_MAX_STDOUT_BYTES,
      maxStderrBytes: GIT_CLI_MAX_STDERR_BYTES,
      maxCombinedOutputBytes: GIT_CLI_MAX_COMBINED_OUTPUT_BYTES,
      discardStderr: false,
    };
  }
  if (!isPlainRecord(value)) {
    throw new GitError("EINVAL", "git CLI run options must be a plain object");
  }
  validateOptionKeys(value);
  const maxStdoutBytes = optionalCeiling(value, "maxStdoutBytes", GIT_CLI_MAX_STDOUT_BYTES);
  const maxStderrBytes = optionalCeiling(value, "maxStderrBytes", GIT_CLI_MAX_STDERR_BYTES);
  const maxCombinedOutputBytes = optionalCeiling(
    value,
    "maxCombinedOutputBytes",
    GIT_CLI_MAX_COMBINED_OUTPUT_BYTES,
  );
  let discardStderr = false;
  if (Object.hasOwn(value, "discardStderr")) {
    const option: unknown = Reflect.get(value, "discardStderr");
    if (typeof option !== "boolean") {
      throw new GitError("EINVAL", "git CLI discardStderr must be a boolean");
    }
    discardStderr = option;
  }
  let logLimitHint: number | undefined;
  if (Object.hasOwn(value, "logLimitHint")) {
    logLimitHint = ceiling(
      Reflect.get(value, "logLimitHint"),
      "logLimitHint",
      GIT_CLI_MAX_LOG_COUNT,
    );
  }
  return {
    maxStdoutBytes,
    maxStderrBytes,
    maxCombinedOutputBytes,
    discardStderr,
    logLimitHint,
  };
}

export function boundedGitCliResult(
  result: GitCliResult,
  options: ResolvedGitCliRunOptions,
): GitCliResult {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new GitError("EINVAL", "git CLI handler result must be an object");
  }
  const checked = gitCliResult(result.stdout, result.stderr, result.exitCode);
  const stdoutBytes = gitCliUtf8ByteLength(checked.stdout, "git CLI stdout", false);
  if (stdoutBytes > options.maxStdoutBytes) {
    throw new GitError("E2BIG", `git CLI stdout exceeds ${options.maxStdoutBytes} bytes`);
  }
  if (options.discardStderr) {
    if (stdoutBytes > options.maxCombinedOutputBytes) {
      throw new GitError(
        "E2BIG",
        `git CLI combined output exceeds ${options.maxCombinedOutputBytes} bytes`,
      );
    }
    return { stdout: checked.stdout, stderr: "", exitCode: checked.exitCode };
  }
  const stderrBytes = gitCliUtf8ByteLength(checked.stderr, "git CLI stderr", false);
  if (stderrBytes > options.maxStderrBytes) {
    throw new GitError("E2BIG", `git CLI stderr exceeds ${options.maxStderrBytes} bytes`);
  }
  if (stderrBytes > options.maxCombinedOutputBytes - stdoutBytes) {
    throw new GitError(
      "E2BIG",
      `git CLI combined output exceeds ${options.maxCombinedOutputBytes} bytes`,
    );
  }
  return checked;
}

export function gitCliUtf8ByteLength(value: string, label: string, rejectNul: boolean): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (rejectNul && unit === 0) throw new GitError("EINVAL", `${label} must not contain NUL`);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        throw new GitError("EINVAL", `${label} must be well-formed UTF-16`);
      }
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new GitError("EINVAL", `${label} must be well-formed UTF-16`);
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (!Number.isSafeInteger(bytes)) throw new GitError("E2BIG", `${label} is too large`);
  }
  return bytes;
}

function validateResultString(value: unknown, stream: string): asserts value is string {
  if (typeof value !== "string") {
    throw new GitError("EINVAL", `git CLI ${stream} must be a string`);
  }
}

function validateOptionKeys(value: object): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !OPTION_KEYS.has(key)) {
      throw new GitError("EINVAL", `unknown git CLI run option: ${String(key)}`);
    }
  }
}

function optionalCeiling(value: object, key: string, maximum: number): number {
  if (!Object.hasOwn(value, key)) return maximum;
  return ceiling(Reflect.get(value, key), key, maximum);
}

function ceiling(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0 || value > maximum) {
    throw new GitError(
      "EINVAL",
      `git CLI ${label} must be a safe integer from 0 through ${maximum}`,
    );
  }
  return value;
}

function isPlainRecord(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
