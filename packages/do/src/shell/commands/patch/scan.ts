// Finding the next patch in the input.
//
// Everything before a patch header is commentary. A unified header is
// `---`/`+++` followed by an `@@` line, a bare `@@` line, or a `diff --git`
// line with git's extended headers. `Index:` and `Prereq:` lines in the
// commentary are remembered for the patch that follows. Context diffs,
// normal diffs, and ed scripts are recognised only to be refused.

import { isHunkStart } from "./hunk.js";
import { gitLineNames, type HeaderName, parseHeaderName } from "./names.js";
import { PatchFatalError, PatchRefusal, plural, type Report } from "./report.js";
import {
  endsWithCr,
  hasNul,
  indentOf,
  type Line,
  lineText,
  type PatchInput,
  PatchText,
  startsWith,
} from "./text.js";

export interface GitInfo {
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldMode: number | null;
  readonly newMode: number | null;
  readonly newFile: boolean;
  readonly deletedFile: boolean;
  readonly rename: boolean;
  readonly copy: boolean;
  readonly binary: boolean;
}

export interface PatchHeader {
  /** First line of the commentary before this patch. */
  readonly start: number;
  /** The first `@@` line, or where the header ended when there is none. */
  readonly body: number;
  readonly hasHunks: boolean;
  readonly text: PatchText;
  readonly old: HeaderName | null;
  readonly new: HeaderName | null;
  readonly index: string | null;
  readonly prereq: string | null;
  readonly git: GitInfo | null;
}

const NORMAL_COMMAND = /^\d+(?:,\d+)?[acd]\d+(?:,\d+)?$/;
const ED_COMMAND = /^\d+(?:,\d+)?[acdi]$/;
const SYMLINK_MODE = 0o120000;

export function nextPatch(input: PatchInput, from: number, report: Report): PatchHeader | null {
  let index: string | null = null;
  let prereq: string | null = null;
  for (let at = from; ; at++) {
    const raw = readScanned(input, at, report);
    if (raw === null) return null;
    const text = new PatchText(input, indentOf(raw.bytes), endsWithCr(raw.bytes));
    const line = text.line(at);
    if (line === null) return null;
    const next = text.line(at + 1);
    const found = (header: PatchHeader): PatchHeader => {
      if (text.indent > 0) report.verbose(`(Patch is indented ${plural(text.indent, "space")}.)\n`);
      if (header.text.stripCr) {
        report.verbose("(Stripping trailing CRs from patch; use --binary to disable.)\n");
      }
      return header;
    };

    if (startsWith(line, "diff --git ")) {
      return found(readGitHeader(input, text, from, at, index, prereq, report));
    }
    if (startsWith(line, "--- ") && next !== null && startsWith(next, "+++ ")) {
      if (isHunkStart(text.line(at + 2))) {
        // GNU strips CRs when the `+++` line ends in one.
        const plus = input.raw(at + 1);
        const unified = new PatchText(input, text.indent, plus !== null && endsWithCr(plus.bytes));
        return found({
          start: from,
          body: at + 2,
          hasHunks: true,
          text: unified,
          old: parseHeaderName(field(line, 4)),
          new: parseHeaderName(field(next, 4)),
          index,
          prereq,
          git: null,
        });
      }
    }
    if (isHunkStart(line)) {
      const bare = new PatchText(input, text.indent, false);
      const header = { start: from, body: at, hasHunks: true, text: bare, old: null, new: null };
      return found({ ...header, index, prereq, git: null });
    }
    const plain = lineText(line);
    if (
      (startsWith(line, "*** ") && next !== null && startsWith(next, "--- ")) ||
      startsWith(line, "***************")
    ) {
      throw new PatchRefusal("context diffs are not supported; use a unified diff");
    }
    if (NORMAL_COMMAND.test(plain)) {
      throw new PatchRefusal("normal diffs are not supported; use a unified diff");
    }
    if (ED_COMMAND.test(plain))
      throw new PatchRefusal("ed scripts are not supported; use a unified diff");
    if (startsWith(line, "Index:")) index = plain.slice(6).trim().split(/\s/)[0] ?? null;
    if (startsWith(line, "Prereq:")) prereq = plain.slice(7).trim().split(/\s/)[0] ?? null;
  }
}

/** Read a line the scan passes over: NUL is fatal, a missing final newline is reported. */
function readScanned(input: PatchInput, at: number, report: Report): Line | null {
  const raw = input.raw(at);
  if (raw === null) return null;
  if (hasNul(raw)) throw new PatchFatalError(`patch line ${at + 1} contains NUL byte`);
  if (!raw.newline) report.always("patch unexpectedly ends in middle of line\n");
  return raw;
}

function field(line: Line, from: number): string {
  return lineText({ bytes: line.bytes.subarray(from), newline: false });
}

function readGitHeader(
  input: PatchInput,
  text: PatchText,
  from: number,
  at: number,
  index: string | null,
  prereq: string | null,
  report: Report,
): PatchHeader {
  const names = gitLineNames(
    field(text.line(at) ?? { bytes: new Uint8Array(), newline: false }, 11),
  );
  let oldMode: number | null = null;
  let newMode: number | null = null;
  let newFile = false;
  let deletedFile = false;
  let rename = false;
  let copy = false;
  let cursor = at + 1;
  for (; ; cursor++) {
    const line = text.line(cursor);
    if (line === null) break;
    const value = lineText(line);
    const mode = (prefix: string): number | null =>
      value.startsWith(prefix) ? Number.parseInt(value.slice(prefix.length), 8) : null;
    if (value.startsWith("old mode ")) oldMode = mode("old mode ");
    else if (value.startsWith("new mode ")) newMode = mode("new mode ");
    else if (value.startsWith("deleted file mode ")) {
      deletedFile = true;
      oldMode = mode("deleted file mode ");
    } else if (value.startsWith("new file mode ")) {
      newFile = true;
      newMode = mode("new file mode ");
    } else if (value.startsWith("rename from ") || value.startsWith("rename to ")) rename = true;
    else if (value.startsWith("copy from ") || value.startsWith("copy to ")) copy = true;
    else if (
      !value.startsWith("similarity index ") &&
      !value.startsWith("dissimilarity index ") &&
      !value.startsWith("index ")
    ) {
      break;
    }
    readScanned(input, cursor, report);
  }
  if (oldMode === SYMLINK_MODE || newMode === SYMLINK_MODE) {
    throw new PatchRefusal("patches to symbolic links are not supported");
  }

  let old: HeaderName | null = null;
  let renamed: HeaderName | null = null;
  const minus = text.line(cursor);
  const plus = text.line(cursor + 1);
  if (minus !== null && plus !== null && startsWith(minus, "--- ") && startsWith(plus, "+++ ")) {
    old = parseHeaderName(field(minus, 4));
    renamed = parseHeaderName(field(plus, 4));
    cursor += 2;
  }
  const body = text.line(cursor);
  const binary =
    body !== null && (startsWith(body, "GIT binary patch") || startsWith(body, "Binary files "));
  return {
    start: from,
    body: cursor,
    hasHunks: isHunkStart(body),
    text,
    old,
    new: renamed,
    index,
    prereq,
    git: {
      oldPath: names?.old ?? null,
      newPath: names?.new ?? null,
      oldMode,
      newMode,
      newFile,
      deletedFile,
      rename,
      copy,
      binary,
    },
  };
}
