// `chmod` matching the observed behaviour of the host's chmod (GNU coreutils
// 9.5), the parity reference.
//
// The umask is fixed at 022: the shell has no process umask, and 022 is
// what a who-less `+w` or `-r` is masked by. `-R` pages the subtree through
// `scan` and changes only entries whose mode moves; symlinks met inside the
// walk are left alone, as GNU's default -P traversal leaves them.

import type { Stat } from "../../../fs/types.js";
import { encode } from "../../exec/bytes.js";
import {
  type Command,
  type CommandContext,
  type CommandResult,
  result,
} from "../../exec/context.js";
import { strerror } from "../../exec/errno.js";
import { resolve } from "../../exec/execute.js";
import { isFilesystemError } from "../../exec/redirections.js";
import { ChmodUsage, parseChmodArgs, type Verbosity } from "./chmod-args.js";
import { adjustMode, compileMode, type ModeChanges, octalMode, permissionString } from "./mode.js";
import { HeldOutput, quote } from "./output.js";

export const UMASK = 0o022;
const SCAN_PAGE = 1_000;

interface Job {
  readonly context: CommandContext;
  readonly output: HeldOutput;
  readonly changes: ModeChanges;
  readonly verbosity: Verbosity;
  /** Set when the mode came from `-w`-style options, where the host reports what the umask blocked. */
  readonly diagnoseSurprises: boolean;
}

export const chmod: Command = (context) => {
  try {
    return run(context);
  } catch (error) {
    if (!(error instanceof ChmodUsage)) throw error;
    return usage(context, error.message);
  }
};

function usage(context: CommandContext, message: string): CommandResult {
  context.warn(message);
  context.diagnostic(encode("Try 'chmod --help' for more information.\n"));
  return result((function* () {})(), 1);
}

function run(context: CommandContext): CommandResult {
  const args = parseChmodArgs(context.argv);
  const operands = [...args.operands];
  let mode = args.optionMode;
  if (mode === null) {
    const first = operands.shift();
    if (first === undefined) return usage(context, "missing operand");
    mode = first;
    if (operands.length === 0) return usage(context, `missing operand after ${quote(first)}`);
  } else if (operands.length === 0) {
    return usage(context, "missing operand");
  }
  const changes = compileMode(mode);
  if (changes === null) return usage(context, `invalid mode: ${quote(mode)}`);

  const job: Job = {
    context,
    output: new HeldOutput(context),
    changes,
    verbosity: args.verbosity,
    diagnoseSurprises: args.optionMode !== null,
  };
  let status = 0;
  for (const operand of operands) {
    if (!changeOperand(job, operand, args.recursive)) status = 1;
  }
  return job.output.result(status);
}

function changeOperand(job: Job, operand: string, recursive: boolean): boolean {
  const { context } = job;
  const path = resolve(context.cwd, operand);
  const target = accessTarget(job, operand, path);
  if (target === null) {
    if (job.verbosity === "high") job.output.write(`${quote(operand)} could not be accessed\n`);
    return false;
  }

  let succeeded = changeOne(job, operand, path, target);
  if (!recursive || target.type !== "dir") return succeeded;

  const root = context.fs.realpath(path);
  const rootPrefix = root === "/" ? root : `${root}/`;
  const shownPrefix = operand.endsWith("/") ? operand : `${operand}/`;
  let after: string | undefined;
  for (;;) {
    const page = context.fs.scan(
      root,
      after === undefined ? { limit: SCAN_PAGE } : { after, limit: SCAN_PAGE },
    );
    for (const entry of page) {
      const shown = `${shownPrefix}${entry.path.slice(rootPrefix.length)}`;
      if (entry.type === "symlink") {
        if (job.verbosity === "high") {
          job.output.write(`neither symbolic link ${quote(shown)} nor referent has been changed\n`);
        }
        continue;
      }
      if (!changeOne(job, shown, entry.path, entry)) succeeded = false;
    }
    const last = page[page.length - 1];
    if (page.length < SCAN_PAGE || last === undefined) return succeeded;
    after = last.path;
  }
}

/** The stat chmod(2) acts on, or null after reporting why there is none. */
function accessTarget(job: Job, operand: string, path: string): Stat | null {
  const { context } = job;
  try {
    const found = context.fs.stat(path);
    if (found === null) {
      // stat() folds ENOTDIR into absence; resolution names the real reason.
      context.fs.realpath(path);
      context.warn(`cannot access ${quote(operand)}: No such file or directory`);
      return null;
    }
    if (found.type !== "symlink") return found;
    const target = context.fs.statTarget(path);
    if (target === null) context.warn(`cannot operate on dangling symlink ${quote(operand)}`);
    return target;
  } catch (error) {
    if (!isFilesystemError(error)) throw error;
    context.warn(`cannot access ${quote(operand)}: ${strerror(error)}`);
    return null;
  }
}

function changeOne(job: Job, shown: string, path: string, stat: Stat): boolean {
  const directory = stat.type === "dir";
  const oldMode = stat.mode & 0o7777;
  const newMode = adjustMode(oldMode, directory, UMASK, job.changes);
  if (newMode !== oldMode) job.context.fs.chmod(path, newMode);

  const changed = newMode !== oldMode;
  if (changed && job.verbosity !== "normal") {
    job.output.write(
      `mode of ${quote(shown)} changed from ${octalMode(oldMode)} (${permissionString(oldMode)}) ` +
        `to ${octalMode(newMode)} (${permissionString(newMode)})\n`,
    );
  } else if (!changed && job.verbosity === "high") {
    job.output.write(
      `mode of ${quote(shown)} retained as ${octalMode(newMode)} (${permissionString(newMode)})\n`,
    );
  }

  if (!job.diagnoseSurprises) return true;
  const withoutUmask = adjustMode(oldMode, directory, 0, job.changes);
  if ((newMode & ~withoutUmask) === 0) return true;
  job.context.warn(
    `${quoteIfNeeded(shown)}: new permissions are ${permissionString(newMode)}, ` +
      `not ${permissionString(withoutUmask)}`,
  );
  return false;
}

/** The host quotes a name in this message only when the shell would need it quoted. */
function quoteIfNeeded(name: string): string {
  return /^[A-Za-z0-9%+,./:=@_^-]+$/.test(name) ? name : quote(name);
}
