// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Ported from the xdiff library as it appears in git, which derives from
// LibXDiff, Copyright (C) 2003 Davide Libenzi <davidel@xmailserver.org>.
// LGPL-2.1-or-later, like the original. See ./LICENSE — this directory is
// the one part of kompjutr that is not MIT.

// Turning change groups into unified-diff hunks, following xdiff/xemit.c.

import type { ChangeGroup } from "./myers.js";

/** How wide git's function-name buffer is, in characters. */
const FUNC_NAME_LIMIT = 80;

export interface UnifiedOptions {
  /** Context lines around each hunk. git's default is 3. */
  context?: number;
  /** Append the enclosing "function" line to hunk headers, as git does. */
  functionNames?: boolean;
}

/**
 * The hunks of a unified diff, with no `diff --git` / `---` / `+++`
 * header: those need oids and modes, which live a layer up.
 */
export function unifiedHunks(
  oldLines: string[],
  newLines: string[],
  changes: ChangeGroup[],
  options: UnifiedOptions = {},
): string {
  const context = options.context ?? 3;
  const functionNames = options.functionNames !== false;
  // Two changes closer than this share a hunk, so their context overlaps
  // instead of repeating.
  const maxCommon = context * 2;
  const out: string[] = [];
  let previousFunctionSearch = -1;
  // git keeps the last name it found: a hunk whose own search comes up
  // empty reuses the previous hunk's name rather than printing none.
  let functionName = "";

  let index = 0;
  while (index < changes.length) {
    let last = index;
    while (last + 1 < changes.length) {
      const previous = changes[last]!;
      const next = changes[last + 1]!;
      if (next.oldStart - (previous.oldStart + previous.oldCount) > maxCommon) break;
      last++;
    }
    const first = changes[index]!;
    const final = changes[last]!;

    const start1 = Math.max(first.oldStart - context, 0);
    let start2 = Math.max(first.newStart - context, 0);
    const trailing = Math.min(
      context,
      oldLines.length - (final.oldStart + final.oldCount),
      newLines.length - (final.newStart + final.newCount),
    );
    const end1 = final.oldStart + final.oldCount + trailing;
    const end2 = final.newStart + final.newCount + trailing;

    if (functionNames) {
      const found = findFunctionLine(oldLines, start1 - 1, previousFunctionSearch);
      if (found !== null) functionName = found;
      previousFunctionSearch = start1 - 1;
    }
    out.push(hunkHeader(start1 + 1, end1 - start1, start2 + 1, end2 - start2, functionName));

    for (; start2 < first.newStart; start2++) emitRecord(out, " ", newLines[start2]!);
    for (let i = index; i <= last; i++) {
      const change = changes[i]!;
      if (i > index) {
        const previous = changes[i - 1]!;
        for (let line = previous.newStart + previous.newCount; line < change.newStart; line++) {
          emitRecord(out, " ", newLines[line]!);
        }
      }
      for (let line = change.oldStart; line < change.oldStart + change.oldCount; line++) {
        emitRecord(out, "-", oldLines[line]!);
      }
      for (let line = change.newStart; line < change.newStart + change.newCount; line++) {
        emitRecord(out, "+", newLines[line]!);
      }
    }
    for (let line = final.newStart + final.newCount; line < end2; line++) {
      emitRecord(out, " ", newLines[line]!);
    }

    index = last + 1;
  }
  return out.join("");
}

function emitRecord(out: string[], prefix: string, line: string): void {
  if (line.endsWith("\n")) out.push(`${prefix}${line}`);
  else out.push(`${prefix}${line}\n\\ No newline at end of file\n`);
}

function hunkHeader(
  start1: number,
  count1: number,
  start2: number,
  count2: number,
  functionName: string,
): string {
  const left = count1 === 1 ? `${start1}` : `${count1 === 0 ? start1 - 1 : start1},${count1}`;
  const right = count2 === 1 ? `${start2}` : `${count2 === 0 ? start2 - 1 : start2},${count2}`;
  const suffix = functionName === "" ? "" : ` ${functionName}`;
  return `@@ -${left} +${right} @@${suffix}\n`;
}

/**
 * git's default "function" heuristic: search backwards from `start` for a
 * line beginning with an identifier character, stopping at `limit` so a
 * hunk never rescans what the previous hunk already covered. Null means
 * "nothing found", which leaves the caller's current name in place.
 */
function findFunctionLine(lines: string[], start: number, limit: number): string | null {
  const step = start > limit ? -1 : 1;
  for (let line = start; line !== limit && line >= 0 && line < lines.length; line += step) {
    const text = lines[line]!;
    const first = text[0];
    if (first === undefined) continue;
    if (!/[A-Za-z_$]/.test(first)) continue;
    return text.slice(0, FUNC_NAME_LIMIT).replace(/\s+$/, "");
  }
  return null;
}
