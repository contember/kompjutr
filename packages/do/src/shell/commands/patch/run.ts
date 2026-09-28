// GNU patch's main loop over the patches in one input: find the next header,
// choose the file, apply each hunk with offset and fuzz, then publish the
// result, its backup, and its rejects. Exit status is 0 when everything
// applied, 1 when a hunk failed or a patch was skipped, 2 on a fatal error.

import { concat } from "../../exec/bytes.js";
import type { CommandContext } from "../../exec/context.js";
import { readHunk } from "./hunk.js";
import { type Header, intuit, touchesSymlink } from "./intuit.js";
import { PatchFatal } from "./messages.js";
import { isSpace, quote } from "./names.js";
import { rejectHunk } from "./reject.js";
import { reach } from "./safety.js";
import { chooseFile } from "./select.js";
import type { Session } from "./session.js";
import type { PatchSource } from "./source.js";
import { splitLines, Target } from "./target.js";

const REFUSED_KINDS = new Map([
  ["context", "context diffs"],
  ["normal", "normal diffs"],
  ["ed", "ed scripts"],
]);

/** Apply every patch in `source`; the exit status. Fatal errors propagate. */
export function applyAll(context: CommandContext, session: Session, source: PatchSource): number {
  let failedSome = false;
  let inGitDiff = false;
  for (;;) {
    session.reset();
    const header = nextPatch(context, session, source);
    if (header === null) break;
    let flushed = false;
    if (header.git !== inGitDiff) {
      if (inGitDiff) session.publisher.flush();
      flushed = inGitDiff;
      inGitDiff = header.git;
    }
    if (!applyOne(context, session, source, header, flushed)) failedSome = true;
  }
  session.publisher.flush();
  session.publisher.finish();
  return failedSome ? 1 : 0;
}

/** GNU's `there_is_another_patch`. */
function nextPatch(context: CommandContext, session: Session, source: PatchSource): Header | null {
  const { options } = session;
  if (source.base !== 0 && source.base >= source.size) return null;
  const say = (text: string): void => session.say(text);
  const header = intuit(source, options.target === null, options.strip, say);
  if (header === null) {
    if (source.base === 0 && source.size > 0) {
      throw new PatchFatal("Only garbage was found in the patch input.");
    }
    return null;
  }
  const refused = REFUSED_KINDS.get(header.kind);
  if (refused !== undefined) {
    throw new PatchFatal(`${refused} are not supported; use a unified diff`, false);
  }
  if (touchesSymlink(header)) {
    throw new PatchFatal("patches to symbolic links are not supported", false);
  }
  chooseFile(session, header, context.fs);
  if (session.skipRest) {
    source.seek(header.start, header.startLine);
    return header;
  }
  if (!options.silent) {
    if (header.indent > 0) {
      say(`(Patch is indented ${header.indent} space${header.indent === 1 ? "" : "s"}.)\n`);
    }
    if (header.stripCr) say("(Stripping trailing CRs from patch; use --binary to disable.)\n");
    if (session.inname === null) {
      say(`can't find file to patch at input line ${header.startLine}\n`);
      say(
        options.strip < 0
          ? "Perhaps you should have used the -p or --strip option?\n"
          : "Perhaps you used the wrong -p or --strip option?\n",
      );
    }
  }
  if (session.inname === null && source.base < header.start) {
    say("The text leading up to this was:\n--------------------------\n");
    for (const line of source.rawLines(source.base, header.start)) {
      session.say("|");
      session.say(line);
    }
    say("--------------------------\n");
  }
  source.seek(header.start, header.startLine);
  if (session.inname === null) {
    if (options.force || options.batch) {
      say("No file to patch.  Skipping patch.\n");
    } else {
      session.ask("File to patch: ");
      session.ask("Skip this patch? [y] ");
      if (!options.silent) say("Skipping patch.\n");
    }
    session.skipRest = true;
  }
  return header;
}

/** One patch of the input; false when any of it failed or was skipped. */
function applyOne(
  context: CommandContext,
  session: Session,
  source: PatchSource,
  header: Header,
  flushed: boolean,
): boolean {
  const { options, publisher } = session;
  const say = (text: string): void => session.say(text);
  let ok = !session.skipRest;
  let outname: string | null = null;
  if (!session.skipRest) {
    outname = header.copy || header.rename ? header.names[session.reverse ? 0 : 1] : session.inname;
  }
  const inname = session.inname;
  // The status chosen with the name stands, a pending deletion included,
  // unless publishing queued output may have changed the file.
  let restat = flushed;
  const restatInput = (): void => {
    if (inname !== null) session.inStat = context.fs.stat(publisher.path(inname));
    restat = false;
  };
  if (header.git && !session.skipRest && outname !== null) {
    if (inname === outname && restat) restatInput();
    const exists =
      inname === outname
        ? session.inStat !== null
        : context.fs.stat(publisher.path(outname)) !== null;
    if (publisher.claim(outname, exists)) restat = true;
  }
  if (restat) restatInput();
  const inStat = session.inStat;
  if (!session.skipRest && inname !== null && inStat !== null && inStat.type !== "file") {
    say(`File ${quote(inname)} is not a regular file -- refusing to patch\n`);
    session.skipRest = true;
    ok = false;
  }
  if (inname !== null && inStat?.type === "file" && (inStat.mode & 0o200) === 0) {
    say(`File ${quote(inname)} is read-only; trying to patch anyway\n`);
  }
  // GNU vets the output name where it creates its temporary file.
  let skipRejects = false;
  const reached =
    outname === null || options.target !== null || options.dryRun
      ? "inside"
      : reach(context.fs, options.cwd, outname);
  if (reached === "dangling") {
    throw new PatchFatal(`Can't create temporary file ${outname} : No such file or directory`);
  }
  if (reached === "outside") {
    say(`Invalid file name ${quote(outname ?? "")} -- skipping patch\n`);
    session.skipRest = true;
    skipRejects = true;
    ok = false;
  }
  if (!session.skipRest && header.kind === "binary") {
    say(`File ${quote(outname ?? "")}: git binary diffs are not supported.\n`);
    session.skipRest = true;
    ok = false;
  }

  const input = readInput(context, session, header);
  try {
    const target = input === null ? null : new Target(splitLines(input.bytes));
    if (target !== null && outname !== null && !options.silent) {
      const renamed = inname !== outname;
      const already = !renamed && header.rename;
      const verb = options.dryRun ? "checking" : "patching";
      say(`${verb} file ${quote(outname)}${renamed || already ? " " : "\n"}`);
      if (renamed || already) {
        const how = header.copy ? "copied" : header.rename ? "renamed" : "read";
        const from = already ? header.names[inname === header.names[0] ? 1 : 0] : inname;
        say(`(${already ? "already " : ""}${how} from ${from ?? ""})\n`);
      }
    }
    const outcome = applyHunks(session, source, header, target);
    if (target !== null && !session.skipRest && !target.finish(say)) {
      say("Skipping patch.\n");
      session.skipRest = true;
    }
    if (target !== null && outname !== null && !session.skipRest) {
      if (!publish(context, session, header, target, outname, outcome)) ok = false;
    }
    if (outcome.failed > 0) {
      ok = false;
      if (!skipRejects) reportRejects(session, outname, outcome);
    }
  } finally {
    input?.release();
  }
  return ok;
}

interface Outcome {
  hunks: number;
  failed: number;
  mismatch: boolean;
  readonly rejects: Uint8Array[];
}

function applyHunks(
  session: Session,
  source: PatchSource,
  header: Header,
  target: Target | null,
): Outcome {
  const { options } = session;
  const say = (text: string): void => session.say(text);
  const style = {
    indent: header.indent,
    nesting: header.nesting,
    stripCr: header.stripCr,
    allowNul: true,
  };
  const outcome: Outcome = { hunks: 0, failed: 0, mismatch: false, rejects: [] };
  let applyAnyway = false;
  for (
    let hunk = readHunk(source, style, session.reverse);
    hunk !== null;
    hunk = readHunk(source, style, session.reverse)
  ) {
    const context = Math.max(hunk.prefixContext, hunk.suffixContext);
    const maxFuzz = Math.min(options.maxFuzz, context);
    outcome.hunks++;
    let where = 0;
    let fuzz = 0;
    if (!session.skipRest && target !== null) {
      for (;;) {
        let step = 1;
        where = target.locate(hunk, fuzz);
        if (where === 0 || fuzz > 0 || target.inOffset !== 0) outcome.mismatch = true;
        if (
          outcome.hunks === 1 &&
          where === 0 &&
          !(options.force || applyAnyway) &&
          session.reverse === options.reverse
        ) {
          hunk.swap();
          where = target.locate(hunk, fuzz);
          const detected = session.reverse ? "Unreversed" : "Reversed (or previously applied)";
          if (where !== 0 && session.okToReverse(`${detected} patch detected!`)) {
            session.reverse = !session.reverse;
          } else {
            hunk.swap();
            if (where !== 0) {
              applyAnyway = true;
              step = 0;
              where = 0;
            }
          }
        }
        if (session.skipRest || where !== 0) break;
        fuzz += step;
        if (fuzz > maxFuzz) break;
      }
    }
    const outOffset = target?.outOffset ?? 0;
    const newWhere = (where !== 0 ? where : hunk.first) + outOffset;
    const rev = session.reverse ? 1 : 0;
    if (
      session.skipRest ||
      target === null ||
      (where === 1 && header.existence[rev] === 2 && (session.inStat?.size ?? 0) > 0) ||
      where === 0 ||
      !target.apply(hunk, where, say)
    ) {
      outcome.rejects.push(
        ...rejectHunk(hunk, header, outOffset, outcome.failed === 0, session.reverse),
      );
      outcome.failed++;
      if (!session.skipRest && !options.silent && target !== null) {
        const endings = target.lineEndingsDiffer(hunk, newWhere) ? " (different line endings)" : "";
        say(`Hunk #${outcome.hunks} FAILED at ${newWhere}${endings}.\n`);
      }
    } else if (!options.silent && (fuzz > 0 || target.inOffset !== 0)) {
      let text = `Hunk #${outcome.hunks} succeeded at ${newWhere}`;
      if (fuzz > 0) text += ` with fuzz ${fuzz}`;
      const offset = target.inOffset;
      // GNU writes "offset -1 lines".
      if (offset !== 0) text += ` (offset ${offset} line${offset === 1 ? "" : "s"})`;
      say(`${text}.\n`);
    }
  }
  return outcome;
}

/** The file's bytes and lines, held while it is patched; null when skipping. */
function readInput(
  context: CommandContext,
  session: Session,
  header: Header,
): { readonly bytes: Uint8Array; release(): void } | null {
  if (session.skipRest || session.inname === null) return null;
  const stat = session.inStat;
  if (stat === null || stat.size === 0) {
    checkRevision(session, header, new Uint8Array(0));
    return { bytes: new Uint8Array(0), release: () => {} };
  }
  const release = context.fs.retained.retain(stat.size, "patch target");
  try {
    const bytes = context.fs.readFile(session.publisher.path(session.inname));
    checkRevision(session, header, bytes);
    return { bytes, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** GNU's `Prereq:` check: the revision must appear in the file as a word. */
function checkRevision(session: Session, header: Header, bytes: Uint8Array): void {
  const revision = header.revision;
  if (revision === null) return;
  const needle = new TextEncoder().encode(revision);
  const limit = bytes.length - needle.length;
  let found = false;
  for (let at = 0; at < limit && !found; at++) {
    if (!needle.every((byte, offset) => bytes[at + offset] === byte)) continue;
    const before = at === 0 || isSpace(bytes[at - 1]);
    const after = at + 1 === limit || isSpace(bytes[at + needle.length]);
    found = before && after;
  }
  if (found) return;
  const { force, batch, silent } = session.options;
  const version = quote(revision);
  if (force) {
    if (!silent) {
      session.say(
        `Warning: this file doesn't appear to be the ${version} version -- patching anyway.\n`,
      );
    }
    return;
  }
  if (batch) {
    throw new PatchFatal(`This file doesn't appear to be the ${version} version -- aborting.`);
  }
  session.ask(`This file doesn't appear to be the ${version} version -- patch anyway? [n] `);
  throw new PatchFatal("aborted");
}

/** Write, back up, or delete the patched file. False when a deletion was refused. */
function publish(
  context: CommandContext,
  session: Session,
  header: Header,
  target: Target,
  outname: string,
  outcome: Outcome,
): boolean {
  const { options, publisher } = session;
  const rev = session.reverse ? 1 : 0;
  const backup = options.backupIfMismatch && (outcome.mismatch || outcome.failed > 0);
  const other = session.reverse ? 0 : 1;
  const deletes = header.existence[other] === 2;
  if (target.zeroOutput && (options.removeEmpty || deletes)) {
    if (!options.dryRun) publisher.deleteLater(outname, backup);
    return true;
  }
  let ok = true;
  if (!target.zeroOutput && deletes) {
    ok = false;
    if (!options.silent) {
      session.say(`Not deleting file ${quote(outname)} as content differs from patch\n`);
    }
  }
  if (options.dryRun) return ok;
  const oldMode = header.modes[rev];
  const newMode = header.modes[other];
  const setMode = newMode !== 0 && oldMode !== newMode;
  if (outcome.failed < outcome.hunks || setMode || header.copy || header.rename) {
    const stat = session.inStat;
    const mode = setMode ? newMode & 0o777 : stat === null ? 0o644 : stat.mode & 0o777;
    const bytes = concatOutput(context, target);
    try {
      const queued = header.git && header.existence[rev] !== 2;
      publisher.output(outname, bytes.bytes, mode, backup, queued);
    } finally {
      bytes.release();
    }
    const inname = session.inname;
    if (header.rename && inname !== null) publisher.deleteLater(inname, backup);
  } else if (backup) {
    publisher.backupInPlace(outname);
  }
  return ok;
}

function concatOutput(
  context: CommandContext,
  target: Target,
): { readonly bytes: Uint8Array; release(): void } {
  let size = 0;
  for (const chunk of target.output) size += chunk.length;
  const release = context.fs.retained.retain(size, "patch output file");
  return { bytes: concat(target.output), release };
}

function reportRejects(session: Session, outname: string | null, outcome: Outcome): void {
  const { options, publisher } = session;
  const noun = `hunk${outcome.hunks === 1 ? "" : "s"}`;
  const verb = session.skipRest ? "ignored" : "FAILED";
  session.say(`${outcome.failed} out of ${outcome.hunks} ${noun} ${verb}`);
  const named = options.rejectFile;
  if (outname === null || named === "-") {
    session.say("\n");
    return;
  }
  const name = named ?? `${outname}.rej`;
  if (options.dryRun) {
    session.say("\n");
    return;
  }
  session.say(` -- saving rejects to file ${quote(name)}\n`);
  publisher.reject(name, outcome.rejects);
}
