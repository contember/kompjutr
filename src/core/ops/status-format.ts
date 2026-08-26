import { GitError } from "../errors.js";
import type { StatusEntry } from "./kinds.js";
import type { StatusBranch } from "./status.js";
import type { StatusDetail } from "./status-rows.js";

/** `git status --porcelain=v2`, with optional `--branch` headers. */
export function formatPorcelainV2(entries: StatusDetail[], branch?: StatusBranch): string {
  const lines = branch === undefined ? [] : formatStatusBranch(branch);
  for (const entry of entries) {
    if (entry.ignored === true || entry.worktree === "?") continue;
    if (entry.unmerged === true) {
      lines.push(
        `u ${entry.index}${entry.worktree} N... ` +
          `${entry.baseMode} ${entry.currentMode} ${entry.incomingMode} ${entry.worktreeMode} ` +
          `${entry.baseOid} ${entry.currentOid} ${entry.incomingOid} ${entry.path}`,
      );
      continue;
    }
    if (entry.renamed === true) {
      lines.push(
        `2 ${entry.index}${v2Code(entry.worktree)} N... ` +
          `${entry.headMode} ${entry.indexMode} ${entry.worktreeMode} ` +
          `${entry.headOid} ${entry.indexOid} R${entry.similarity} ` +
          `${entry.path}\t${entry.originalPath}`,
      );
      continue;
    }
    lines.push(
      `1 ${v2Code(entry.index)}${v2Code(entry.worktree)} N... ` +
        `${entry.headMode} ${entry.indexMode} ${entry.worktreeMode} ` +
        `${entry.headOid} ${entry.indexOid} ${entry.path}`,
    );
  }
  for (const entry of entries) if (entry.worktree === "?") lines.push(`? ${entry.path}`);
  for (const entry of entries) if (entry.ignored === true) lines.push(`! ${entry.path}`);
  return join(lines);
}

function formatStatusBranch(branch: StatusBranch): string[] {
  const lines = [
    `# branch.oid ${branch.oid ?? "(initial)"}`,
    `# branch.head ${branch.head ?? "(detached)"}`,
  ];
  if (branch.upstream !== undefined) lines.push(`# branch.upstream ${branch.upstream}`);
  if (branch.ahead !== undefined || branch.behind !== undefined) {
    if (
      branch.upstream === undefined ||
      branch.ahead === undefined ||
      branch.behind === undefined
    ) {
      throw new GitError("EINVAL", "status branch counts require an upstream and both counts");
    }
    lines.push(`# branch.ab +${branch.ahead} -${branch.behind}`);
  }
  return lines;
}

/** `git status --porcelain=v1`. */
export function formatPorcelainV1(entries: StatusEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.worktree === "?" || entry.worktree === "!") continue;
    if (entry.originalPath !== undefined) {
      lines.push(`${entry.index}${entry.worktree} ${entry.originalPath} -> ${entry.path}`);
      continue;
    }
    lines.push(`${entry.index}${entry.worktree} ${entry.path}`);
  }
  for (const entry of entries) if (entry.worktree === "?") lines.push(`?? ${entry.path}`);
  for (const entry of entries) if (entry.worktree === "!") lines.push(`!! ${entry.path}`);
  return join(lines);
}

/**
 * `git status --short`. Identical to porcelain v1 over the states this
 * package models — the two differ only on colour and path quoting.
 */
export function formatShort(entries: StatusEntry[]): string {
  return formatPorcelainV1(entries);
}

/** Porcelain v2 spells "unmodified" as a dot where v1 uses a space. */
function v2Code(code: string): string {
  return code === " " ? "." : code;
}

function join(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
