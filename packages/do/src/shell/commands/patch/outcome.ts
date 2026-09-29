// The two decisions around a file patch that are not about hunks: whether a
// patch that creates an existing file, or deletes a missing one, goes ahead;
// and where its rejects are written.

import { resolve } from "../../exec/arguments.js";
import type { Session } from "./file-patch.js";
import { namesAbsentFile } from "./names.js";
import { chunked, type Rejects, rejectSection } from "./output.js";
import { quoteName } from "./report.js";
import type { PatchHeader } from "./scan.js";
import type { Target } from "./target.js";

export interface Questions {
  readonly skip: boolean;
  /** The direction the hunks are applied in. */
  readonly reverse: boolean;
  /** The answer already chose the direction, so hunks are not checked for reversal. */
  readonly decided: boolean;
}

export function settleQuestions(
  session: Session,
  target: Target,
  creates: boolean,
  deletes: boolean,
): Questions {
  const { options, report } = session;
  const reverse = options.reverse;
  const stat = target.lookup.safe ? target.lookup.stat : null;
  const present = stat !== null && (stat.type !== "file" || stat.size > 0);
  const name = quoteName(target.name);
  let problem: string | null = null;
  if (creates && present) problem = `create the file ${name},\nwhich already exists!`;
  else if (deletes && stat === null) problem = `delete the file ${name},\nwhich does not exist!`;
  if (problem === null) return { skip: false, reverse, decided: false };

  report.always(`The next patch${reverse ? ", when reversed," : ""} would ${problem}  `);
  if (options.forward) {
    report.always("Skipping patch.\n");
    return { skip: true, reverse, decided: true };
  }
  if (options.answers === "batch") {
    report.always(reverse ? "Ignoring -R.\n" : "Assuming -R.\n");
    return { skip: false, reverse: !reverse, decided: true };
  }
  if (options.answers === "force") {
    report.always("Applying it anyway.\n");
    return { skip: false, reverse, decided: true };
  }
  report.always(`${reverse ? "Ignore -R? [n] " : "Assume -R? [n] "}\nApply anyway? [n] \n`);
  report.verbose("Skipping patch.\n");
  return { skip: true, reverse, decided: true };
}

/** The reject header names the patch's two sides; they differ only for a git rename or copy. */
export interface RejectNames {
  readonly from: string;
  readonly target: Target;
}

export interface RejectsWritten {
  /** The name the summary line reports, or null when nothing was written. */
  readonly shown: string | null;
  /** GNU refuses to open a `-r` file that is a symbolic link, after reporting it. */
  readonly refused: string | null;
}

/** Write a file's rejects to their `.rej` file or to the `-r` file. */
export function writeRejects(
  session: Session,
  header: PatchHeader,
  names: RejectNames,
  rejects: Rejects,
  reverse: boolean,
): RejectsWritten {
  const { options, workspace } = session;
  const target = names.target;
  if (options.dryRun || options.rejectFile === "-") return { shown: null, refused: null };
  let path: string;
  let shown: string;
  let append = false;
  if (options.rejectFile !== null) {
    path = resolve(workspace.root, options.rejectFile);
    shown = options.rejectFile;
    append = session.rejectFileStarted;
    if (!append && workspace.isLink(path)) {
      const refused = `Can't create file ${shown} : Too many levels of symbolic links`;
      return { shown, refused };
    }
    session.rejectFileStarted = true;
  } else {
    shown = `${target.name}.rej`;
    // Named beside the target by its name, so `.` rejects into `..rej`.
    if (target.checked) {
      const lookup = workspace.lookup(shown);
      if (!lookup.safe) return { shown: null, refused: null };
      path = lookup.path;
    } else {
      if (!target.lookup.safe) return { shown: null, refused: null };
      path = `${target.lookup.path}.rej`;
    }
  }
  // GNU names a temporary file in this message; the reject file is named instead.
  if (workspace.isDirectory(path))
    return { shown, refused: `Can't create file ${shown} : Is a directory` };
  const section = rejectSection(rejectHeader(header, names, reverse), rejects);
  workspace.writeReject(path, chunked(section, session.fs.retained, "patch rejects"), append);
  return { shown, refused: null };
}

/**
 * The header GNU writes above a file's rejects: each side named as the target
 * unless the patch names that side `/dev/null`, with its timestamp; a patch
 * with no header names gets `/dev/null` on both sides after its `Index:` line.
 */
function rejectHeader(header: PatchHeader, names: RejectNames, reverse: boolean): string {
  const [oldSide, newSide] = reverse ? [header.new, header.old] : [header.old, header.new];
  if (oldSide === null && newSide === null) {
    const index = header.index === null ? "" : `Index: ${header.index}\n`;
    return `${index}--- /dev/null\n+++ /dev/null\n`;
  }
  const oldAbsent = header.git === null ? namesAbsentFile(oldSide) : oldSide?.name === "/dev/null";
  const newAbsent = header.git === null ? namesAbsentFile(newSide) : newSide?.name === "/dev/null";
  const side = (name: string, absent: boolean, stamp: string | null | undefined): string => {
    const shown = absent ? "/dev/null" : name;
    return stamp === null || stamp === undefined ? shown : `${shown}\t${stamp}`;
  };
  return `--- ${side(names.from, oldAbsent, oldSide?.stamp)}\n+++ ${side(names.target.name, newAbsent, newSide?.stamp)}\n`;
}
