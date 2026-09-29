// One patch from the input: choose its file, settle the questions GNU asks
// about it, apply its hunks, and write the result, backup, and rejects.
//
// Without a terminal GNU takes each question's default answer and prints the
// answer's line; `-f`, `-t`, and `-N` replace the questions with their own
// fixed answers. A plain patch is written as soon as it is applied; a git
// patch is queued in the workspace.

import type { BoundedFs } from "../../exec/context.js";
import { applyHunks } from "./apply.js";
import { type Hunk, isHunkStart, readHunk } from "./hunk.js";
import { FileLines } from "./locate.js";
import type { PatchOptions } from "./options.js";
import { type RejectNames, settleQuestions, writeRejects } from "./outcome.js";
import { type Plan, type Reject, render } from "./output.js";
import { PatchFatalError, plural, quoteName, type Report } from "./report.js";
import type { PatchHeader } from "./scan.js";
import { resolveTarget, type Target } from "./target.js";
import { hasNul, indentOf, type PatchInput } from "./text.js";
import type { Workspace } from "./workspace.js";

export interface Session {
  readonly fs: BoundedFs;
  readonly options: PatchOptions;
  readonly workspace: Workspace;
  readonly report: Report;
  readonly input: PatchInput;
  /** A file operand, which every patch in the input is applied to. */
  readonly operand: { readonly name: string; readonly path: string } | null;
  status: number;
  rejectFileStarted: boolean;
}

/** Process one patch; returns where scanning resumes. */
export function processPatch(session: Session, header: PatchHeader): number {
  const { options, report, workspace } = session;
  let cursor = header.body;
  let more = header.hasHunks;
  let peekPending = false;
  // GNU looks at the line after a hunk only once that hunk has been applied.
  const peek = (): void => {
    peekPending = false;
    const following = session.input.raw(cursor);
    if (following !== null) {
      if (hasNul(following))
        throw new PatchFatalError(`patch line ${cursor + 1} contains NUL byte`);
      // The unterminated line is reported here only when it carries the patch's
      // indentation and something after it.
      const indented = indentOf(following.bytes) >= header.text.indent;
      const visible = (header.text.line(cursor)?.bytes.length ?? 0) > 0;
      if (!following.newline && indented && visible) {
        report.always("patch unexpectedly ends in middle of line\n");
      }
    }
    more = isHunkStart(header.text.line(cursor));
  };
  const nextHunk = (): Hunk | null => {
    if (peekPending) peek();
    if (!more) return null;
    const parsed = readHunk(header.text, cursor, report);
    cursor = parsed.next;
    peekPending = true;
    return parsed.hunk;
  };
  const ignoreAll = (): void => {
    let count = 0;
    while (nextHunk() !== null) count++;
    report.always(`${count} out of ${plural(count, "hunk")} ignored\n`);
    session.status = Math.max(session.status, 1);
  };

  const resolved = resolveTarget(header, options, workspace, session.operand, report);
  const git = header.git;
  if (git?.binary) {
    const name = resolved.target?.name ?? "";
    report.always(`File ${quoteName(name)}: git binary diffs are not supported.\n`);
    session.status = Math.max(session.status, 1);
    return header.body + 1;
  }
  const target = resolved.target;
  const source = resolved.source ?? target;
  const unreadable = source !== null && !source.lookup.safe && !resolved.creates;
  if (target === null || source === null || unreadable || missing(resolved, source)) {
    cannotFind(session, header);
    ignoreAll();
    return cursor;
  }
  const escapes = !target.lookup.safe || (target.checked && !workspace.writable(target.name));
  if (!options.dryRun && escapes) {
    report.always(`Invalid file name ${quoteName(target.name)} -- skipping patch\n`);
    while (nextHunk() !== null);
    session.status = Math.max(session.status, 1);
    return cursor;
  }

  const names: RejectNames = { from: resolved.moved?.from ?? target.name, target };
  const questions = settleQuestions(session, target, resolved.creates, resolved.deletes);
  if (questions.skip) {
    ignoreAll();
    return cursor;
  }
  const stat = source.lookup.safe ? source.lookup.stat : null;
  if (stat !== null && stat.type !== "file") {
    report.always(`File ${quoteName(source.name)} is not a regular file -- refusing to patch\n`);
    const rejects: Reject[] = [];
    for (let hunk = nextHunk(); hunk !== null; hunk = nextHunk()) rejects.push({ hunk, shift: 0 });
    finishRejects(session, header, names, rejects, rejects.length, "ignored", options.reverse);
    return cursor;
  }

  const budget = session.fs.retained;
  const label = `patch target ${source.name}`;
  const release = budget.retain(stat?.size ?? 0, label);
  let file: FileLines | null = null;
  try {
    const bytes =
      stat === null || !source.lookup.safe ? new Uint8Array() : workspace.read(source.lookup.path);
    file = new FileLines(bytes, budget, label);
    checkPrereq(session, header, bytes);

    const verb = options.dryRun ? "checking" : "patching";
    report.verbose(`${verb} file ${quoteName(target.name)}${resolved.moved?.note ?? ""}\n`);

    const applied = applyHunks(
      file,
      nextHunk,
      {
        reverse: questions.reverse,
        detectReverse: options.answers !== "force" && !questions.decided,
        answers: options.answers,
        forward: options.forward,
        maxFuzz: options.maxFuzz,
      },
      report,
    );
    if (applied.skipped) {
      finishRejects(
        session,
        header,
        names,
        applied.rejects,
        applied.total,
        "ignored",
        applied.reverse,
      );
      return cursor;
    }
    const mismatch = applied.mismatch || questions.decided;
    const deletes = questions.reverse === options.reverse ? resolved.deletes : resolved.creates;
    write(session, header, target, source, file, applied.plan, {
      backup: options.backupIfMismatch && mismatch && stat !== null,
      deletes,
      hunks: applied.total,
    });
    finishRejects(
      session,
      header,
      names,
      applied.rejects,
      applied.total,
      "FAILED",
      applied.reverse,
    );
    return cursor;
  } finally {
    file?.release();
    release();
  }
}

function missing(resolved: { creates: boolean; deletes: boolean }, source: Target): boolean {
  return (
    source.lookup.safe && source.lookup.stat === null && !resolved.creates && !resolved.deletes
  );
}

function cannotFind(session: Session, header: PatchHeader): void {
  const { report, options } = session;
  report.verbose(`can't find file to patch at input line ${header.body + 1}\n`);
  report.verbose(
    options.strip === null
      ? "Perhaps you should have used the -p or --strip option?\n"
      : "Perhaps you used the wrong -p or --strip option?\n",
  );
  report.always("The text leading up to this was:\n--------------------------\n");
  for (let line = header.start; line < header.body; line++) {
    const raw = session.input.raw(line);
    if (raw === null) break;
    report.always("|");
    report.bytes(raw.bytes);
    report.always("\n");
  }
  report.always("--------------------------\n");
  if (options.answers === "ask") {
    report.always("File to patch: \nSkip this patch? [y] \n");
    report.verbose("Skipping patch.\n");
  } else {
    report.always("No file to patch.  Skipping patch.\n");
  }
}

function checkPrereq(session: Session, header: PatchHeader, bytes: Uint8Array): void {
  const word = header.prereq;
  if (word === null || containsWord(bytes, word)) return;
  const { report, options } = session;
  if (options.answers === "force") {
    report.always(
      `Warning: this file doesn't appear to be the ${word} version -- patching anyway.\n`,
    );
    return;
  }
  if (options.answers === "batch") {
    throw new PatchFatalError(`This file doesn't appear to be the ${word} version -- aborting.`);
  }
  report.always(`This file doesn't appear to be the ${word} version -- patch anyway? [n] \n`);
  throw new PatchFatalError("aborted");
}

function containsWord(bytes: Uint8Array, word: string): boolean {
  const text = new TextDecoder().decode(bytes);
  let at = text.indexOf(word);
  while (at !== -1) {
    const before = at === 0 ? " " : text.charAt(at - 1);
    const after = text.charAt(at + word.length) || " ";
    if (/\s/.test(before) && /\s/.test(after)) return true;
    at = text.indexOf(word, at + 1);
  }
  return false;
}

interface WriteSettings {
  readonly backup: boolean;
  readonly deletes: boolean;
  readonly hunks: number;
}

function write(
  session: Session,
  header: PatchHeader,
  target: Target,
  source: Target,
  file: FileLines,
  plan: Plan,
  settings: WriteSettings,
): void {
  const { options, report, workspace } = session;
  const empty = plan.isEmpty();
  const remove = empty && (settings.deletes || options.removeEmpty);
  if (settings.deletes && !empty) {
    report.verbose(`Not deleting file ${quoteName(target.name)} as content differs from patch\n`);
    session.status = Math.max(session.status, 1);
  }
  if (options.dryRun || !target.lookup.safe || !source.lookup.safe) return;
  const path = target.lookup.path;
  const git = header.git;
  const mode = gitMode(session, header);
  if (git === null && !workspace.queued(path)) {
    if (remove) workspace.removeNow(path, settings.backup);
    else workspace.writeNow(path, render(plan, file, session.fs.retained), settings.backup, mode);
    return;
  }
  const moved = source !== target && source.lookup.path !== path;
  const renames = git?.rename === true;
  const newFile = git?.newFile === true;
  const deletedFile = git?.deletedFile === true;
  if (remove) {
    workspace.queueDelete(path, settings.backup);
  } else if (moved && settings.hunks === 0) {
    workspace.stageCopy(source.lookup.path, path, mode ?? source.lookup.stat?.mode ?? null);
  } else if (!moved && settings.hunks === 0 && !newFile && !deletedFile) {
    if (mode !== null) workspace.queueMode(path, mode);
  } else {
    const kept = mode ?? source.lookup.stat?.mode ?? null;
    workspace.stage(path, render(plan, file, session.fs.retained), settings.backup, kept);
  }
  if (moved && renames) workspace.queueDelete(source.lookup.path, false);
}

function gitMode(session: Session, header: PatchHeader): number | null {
  const git = header.git;
  if (git === null) return null;
  return session.options.reverse ? git.oldMode : git.newMode;
}

function finishRejects(
  session: Session,
  header: PatchHeader,
  names: RejectNames,
  rejects: readonly Reject[],
  total: number,
  verb: "FAILED" | "ignored",
  reverse: boolean,
): void {
  if (rejects.length === 0) return;
  session.status = Math.max(session.status, 1);
  const saved = writeRejects(session, header, names, rejects, reverse);
  const saving = saved === null ? "" : ` -- saving rejects to file ${quoteName(saved)}`;
  session.report.always(`${rejects.length} out of ${plural(total, "hunk")} ${verb}${saving}\n`);
}
