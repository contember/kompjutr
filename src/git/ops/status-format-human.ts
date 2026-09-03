import {
  outputMetrics,
  type StatusFormatBudget,
  StatusTextOutput,
  validateStatusPaths,
} from "./status-format-budget.js";
import { formatPath } from "./status-format-path.js";
import {
  type ResolvedStatusFormatOptions,
  resolveStatusFormatOptions,
  STATUS_FORMAT_MAX_OUTPUT_BYTES,
  type StatusFormatOptions,
  validateStatusBranch,
} from "./status-format-types.js";
import type { StatusDetail } from "./status-rows.js";
import type { StatusBranch } from "./status-types.js";

export function formatShortBranch(branch: StatusBranch): string {
  validateStatusBranch(branch);
  if (branch.head === null) return "## HEAD (no branch)\n";
  if (branch.oid === null) return `## No commits yet on ${branch.head}\n`;
  if (branch.upstream === undefined) return `## ${branch.head}\n`;
  let suffix = "";
  if (branch.ahead === undefined || branch.behind === undefined) suffix = " [gone]";
  else if (branch.ahead > 0 && branch.behind > 0) {
    suffix = ` [ahead ${branch.ahead}, behind ${branch.behind}]`;
  } else if (branch.ahead > 0) suffix = ` [ahead ${branch.ahead}]`;
  else if (branch.behind > 0) suffix = ` [behind ${branch.behind}]`;
  return `## ${branch.head}...${branch.upstream}${suffix}\n`;
}

export function preflightShortBranch(branch: StatusBranch, budget: StatusFormatBudget): void {
  const line = formatShortBranch(branch);
  budget.addRecord(outputMetrics(line.slice(0, -1)));
}

export function formatHumanStatus(
  entries: readonly StatusDetail[],
  branch: StatusBranch,
  options: ResolvedStatusFormatOptions,
  maximum: number,
): string {
  validateStatusBranch(branch);
  const out = new StatusTextOutput(maximum, `git CLI status output exceeds ${maximum} bytes`);
  if (branch.head === null) out.append(`HEAD detached at ${branch.oid?.slice(0, 7)}\n`);
  else out.append(`On branch ${branch.head}\n`);
  appendHumanTracking(out, branch);
  if (branch.oid === null) out.append("\nNo commits yet\n\n");

  const staged = entries.filter((entry) => humanStaged(entry));
  const unmerged = entries.filter((entry) => entry.unmerged === true);
  const unstaged = entries.filter((entry) => humanUnstaged(entry));
  const untracked = entries.filter((entry) => entry.worktree === "?");
  if (staged.length > 0) {
    out.append(
      "Changes to be committed:\n" + '  (use "git restore --staged <file>..." to unstage)\n',
    );
    for (const entry of staged) appendHumanEntry(out, stagedLabel(entry), entry, options);
    out.append("\n");
  }
  if (unmerged.length > 0) {
    const deletion = unmerged.some((entry) => {
      const code = `${entry.index}${entry.worktree}`;
      return code === "DD" || code === "UD" || code === "DU";
    });
    out.append(
      "Unmerged paths:\n" +
        '  (use "git restore --staged <file>..." to unstage)\n' +
        (deletion
          ? '  (use "git add/rm <file>..." as appropriate to mark resolution)\n'
          : '  (use "git add <file>..." to mark resolution)\n'),
    );
    for (const entry of unmerged) {
      out.append(`\t${unmergedLabel(entry)}:   ${formatPath(entry.path, options, true)}\n`);
    }
    out.append("\n");
  }
  if (unstaged.length > 0) {
    out.append(
      "Changes not staged for commit:\n" +
        '  (use "git add <file>..." to update what will be committed)\n' +
        '  (use "git restore <file>..." to discard changes in working directory)\n',
    );
    for (const entry of unstaged) appendHumanEntry(out, commitWorktreeLabel(entry), entry, options);
    out.append("\n");
  }
  if (untracked.length > 0) {
    out.append(
      "Untracked files:\n" + '  (use "git add <file>..." to include in what will be committed)\n',
    );
    for (const entry of untracked) {
      out.append(`\t${formatPath(entry.path, options, true)}\n`);
    }
    out.append("\n");
  }
  if (unmerged.length > 0) {
    out.append('no changes added to commit (use "git add" and/or "git commit -a")\n');
    return out.finish();
  }
  if (staged.length > 0) return out.finish();
  if (unstaged.length > 0) {
    out.append('no changes added to commit (use "git add" and/or "git commit -a")\n');
  } else if (untracked.length > 0) {
    out.append('nothing added to commit but untracked files present (use "git add" to track)\n');
  } else if (branch.oid === null) {
    out.append('nothing to commit (create/copy files and use "git add" to track)\n');
  } else out.append("nothing to commit, working tree clean\n");
  return out.finish();
}

function appendHumanTracking(out: StatusTextOutput, branch: StatusBranch): void {
  if (branch.upstream === undefined) return;
  if (branch.ahead === undefined || branch.behind === undefined) {
    out.append(
      `Your branch is based on '${branch.upstream}', but the upstream is gone.\n` +
        '  (use "git branch --unset-upstream" to fixup)\n\n',
    );
  } else if (branch.ahead === 0 && branch.behind === 0) {
    out.append(`Your branch is up to date with '${branch.upstream}'.\n\n`);
  } else if (branch.ahead > 0 && branch.behind > 0) {
    out.append(
      `Your branch and '${branch.upstream}' have diverged,\n` +
        `and have ${branch.ahead} and ${branch.behind} different commits each, respectively.\n` +
        '  (use "git pull" if you want to integrate the remote branch with yours)\n\n',
    );
  } else if (branch.ahead > 0) {
    out.append(
      `Your branch is ahead of '${branch.upstream}' by ${branch.ahead} commit${branch.ahead === 1 ? "" : "s"}.\n` +
        '  (use "git push" to publish your local commits)\n\n',
    );
  } else if (branch.behind > 0) {
    out.append(
      `Your branch is behind '${branch.upstream}' by ${branch.behind} commit${branch.behind === 1 ? "" : "s"}, and can be fast-forwarded.\n` +
        '  (use "git pull" to update your local branch)\n\n',
    );
  }
}

function humanStaged(entry: StatusDetail): boolean {
  return (
    entry.ignored !== true &&
    entry.unmerged !== true &&
    entry.worktree !== "?" &&
    entry.index !== " "
  );
}

function humanUnstaged(entry: StatusDetail): boolean {
  return (
    entry.ignored !== true &&
    entry.unmerged !== true &&
    entry.worktree !== "?" &&
    entry.worktree !== " "
  );
}

function stagedLabel(entry: StatusDetail): "new file" | "modified" | "deleted" | "renamed" {
  if (entry.renamed === true) return "renamed";
  if (entry.index === "A") return "new file";
  if (entry.index === "D") return "deleted";
  return "modified";
}

function unmergedLabel(entry: StatusDetail): string {
  const code = `${entry.index}${entry.worktree}`;
  if (code === "DD") return "both deleted";
  if (code === "AU") return "added by us";
  if (code === "UD") return "deleted by them";
  if (code === "UA") return "added by them";
  if (code === "DU") return "deleted by us";
  if (code === "AA") return "both added";
  return "both modified";
}

function appendHumanEntry(
  out: StatusTextOutput,
  label: string,
  entry: StatusDetail,
  options: ResolvedStatusFormatOptions,
): void {
  const path =
    "originalPath" in entry && entry.originalPath !== undefined
      ? `${formatPath(entry.originalPath, options, true, true)} -> ${formatPath(entry.path, options, true, true)}`
      : formatPath(entry.path, options, true);
  out.append(`\t${`${label}:`.padEnd(12, " ")}${path}\n`);
}

/** Long status text used when `git commit` finds an unchanged index tree. */
export function formatCommitRefusalStatus(
  entries: StatusDetail[],
  branch: string,
  options: StatusFormatOptions = {},
  maxOutputBytes = STATUS_FORMAT_MAX_OUTPUT_BYTES,
): string {
  const resolved = resolveStatusFormatOptions(options);
  validateStatusPaths(entries);
  const out = new StatusTextOutput(maxOutputBytes);
  out.append(`On branch ${branch}\n`);
  let unstaged = false;
  let untracked = false;
  for (const entry of entries) {
    if (entry.worktree === "?") untracked = true;
    else if (entry.ignored !== true && entry.unmerged !== true && entry.worktree !== " ") {
      unstaged = true;
    }
  }
  if (!unstaged && !untracked) {
    out.append("nothing to commit, working tree clean\n");
    return out.finish();
  }
  if (unstaged) {
    out.append(
      "Changes not staged for commit:\n" +
        '  (use "git add <file>..." to update what will be committed)\n' +
        '  (use "git restore <file>..." to discard changes in working directory)\n',
    );
    for (const entry of entries) {
      if (
        entry.ignored === true ||
        entry.unmerged === true ||
        entry.worktree === "?" ||
        entry.worktree === " "
      ) {
        continue;
      }
      const label = commitWorktreeLabel(entry);
      out.append(`\t${`${label}:`.padEnd(12, " ")}${formatPath(entry.path, resolved, true)}\n`);
    }
    out.append("\n");
  }
  if (untracked) {
    out.append(
      "Untracked files:\n" + '  (use "git add <file>..." to include in what will be committed)\n',
    );
    for (const entry of entries) {
      if (entry.worktree !== "?") continue;
      out.append(`\t${formatPath(entry.path, resolved, true)}\n`);
    }
    out.append("\n");
  }
  out.append(
    unstaged
      ? 'no changes added to commit (use "git add" and/or "git commit -a")\n'
      : 'nothing added to commit but untracked files present (use "git add" to track)\n',
  );
  return out.finish();
}

function commitWorktreeLabel(entry: StatusDetail): "deleted" | "modified" | "typechange" {
  if (entry.worktree === "D") return "deleted";
  if (
    entry.unmerged !== true &&
    entry.ignored !== true &&
    "indexMode" in entry &&
    "worktreeMode" in entry &&
    entry.indexMode.slice(0, 3) !== entry.worktreeMode.slice(0, 3)
  ) {
    return "typechange";
  }
  return "modified";
}
