// The two decisions around a file patch that are not about hunks: whether a
// patch that creates an existing file, or deletes a missing one, goes ahead;
// and where its rejects are written.

import { resolve } from "../../exec/arguments.js";
import type { Session } from "./file-patch.js";
import { chunked, type Reject, rejectSection } from "./output.js";
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

/** Write a file's rejects; returns the name to report, or null when none is written. */
export function writeRejects(
  session: Session,
  header: PatchHeader,
  names: RejectNames,
  rejects: readonly Reject[],
  reverse: boolean,
): string | null {
  const { options, workspace } = session;
  const target = names.target;
  if (options.dryRun || options.rejectFile === "-") return null;
  let path: string;
  let shown: string;
  let append = false;
  if (options.rejectFile !== null) {
    path = resolve(workspace.root, options.rejectFile);
    shown = options.rejectFile;
    append = session.rejectFileStarted;
    session.rejectFileStarted = true;
  } else {
    if (!target.lookup.safe) return null;
    path = `${target.lookup.path}.rej`;
    shown = `${target.name}.rej`;
  }
  const [oldStamp, newStamp] = reverse
    ? [header.new?.stamp, header.old?.stamp]
    : [header.old?.stamp, header.new?.stamp];
  const stamped = (name: string, stamp: string | null | undefined): string =>
    stamp === null || stamp === undefined ? name : `${name}\t${stamp}`;
  const section = rejectSection(
    stamped(names.from, oldStamp),
    stamped(target.name, newStamp),
    rejects,
  );
  workspace.writeReject(path, chunked(section, session.fs.retained, "patch rejects"), append);
  return shown;
}
