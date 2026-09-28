// Which file a patch applies to, by GNU's rule. Of the old, new, and
// `Index:` names that exist, take the one with the fewest components, then
// the shortest basename, then the shortest name. When none exists and the
// patch creates a file, take the name needing the fewest new directories.
// A patch that would create an existing file or delete a missing one looks
// reversed, and is offered for reversal first.

import type { Stat } from "../../../fs/types.js";
import type { BoundedFs } from "../../exec/context.js";
import type { Header } from "./intuit.js";
import { quote } from "./names.js";
import type { Session } from "./session.js";

const NONE = 3;

export function chooseFile(session: Session, header: Header, fs: BoundedFs): void {
  const names = header.names;
  const valid = validator(session);
  const stats: Array<Stat | null> = [null, null, null];
  let chosen = NONE;

  if (session.inname === null) {
    if ((names[0] !== null || names[1] !== null) && names[2] !== null) names[2] = null;
    let last = NONE;
    for (let index = 0; index < 3; index++) {
      const name = names[index];
      if (name === undefined || name === null) continue;
      const stat = fs.stat(session.publisher.path(name));
      stats[index] = stat !== null && !session.publisher.deleteScheduled(name) ? stat : null;
      last = index;
    }
    chosen = bestName(
      names,
      stats.map((stat) => stat === null),
      valid,
    );
    const lastName = names[last];
    const chosenStat = stats[chosen] ?? null;
    if (
      lastName !== undefined &&
      lastName !== null &&
      (chosen === NONE || chosenStat?.type === "file") &&
      maybeReverse(
        session,
        header,
        chosen === NONE ? lastName : (names[chosen] ?? lastName),
        chosen === NONE,
        chosen === NONE || chosenStat?.size === 0,
      ) &&
      chosen === NONE
    ) {
      chosen = last;
    }
    if (chosen === NONE && header.existence[session.reverse ? 1 : 0] !== 0) {
      const missing = names.map((name) =>
        name === null ? 0 : components(name, null) - components(name, fs, session),
      );
      const fewest = Math.min(...missing.filter((_, index) => names[index] !== null));
      chosen = bestName(
        names,
        missing.map((count) => count > fewest),
        valid,
      );
    }
  }

  const from = names[session.reverse ? 1 : 0];
  const to = names[session.reverse ? 0 : 1];
  if (
    (header.rename || header.copy) &&
    session.inname === null &&
    !((chosen === 0 || chosen === 1) && from && to && valid(from) && valid(to))
  ) {
    session.say(`Cannot ${header.rename ? "rename" : "copy"} file without two valid file names\n`);
    session.skipRest = true;
  }

  if (chosen === NONE) {
    if (session.inname !== null) {
      const stat = fs.stat(session.publisher.path(session.inname));
      session.inStat = stat;
      if (stat === null || stat.type === "file") {
        maybeReverse(
          session,
          header,
          session.inname,
          stat === null,
          stat === null || stat.size === 0,
        );
      }
    }
    return;
  }
  session.inname = names[chosen] ?? null;
  session.inStat = stats[chosen] ?? null;
}

function maybeReverse(
  session: Session,
  header: Header,
  name: string,
  nonexistent: boolean,
  isEmpty: boolean,
): boolean {
  // The old side, or the new one when `flip` differs from the direction.
  const existence = (flip: boolean): number => header.existence[session.reverse !== flip ? 1 : 0];
  const looksReversed = (isEmpty ? 0 : 1) < existence(isEmpty);
  // A git index line says the file is empty, so creating or deleting it is fine.
  if (isEmpty && existence(nonexistent) === 1 && existence(!nonexistent) === 2) return false;
  if (looksReversed) {
    const action = nonexistent ? "delete" : isEmpty ? "empty out" : "create";
    const state = nonexistent ? "does not exist" : isEmpty ? "is already empty" : "already exists";
    const when = session.reverse ? ", when reversed," : "";
    const message = `The next patch${when} would ${action} the file ${quote(name)},\nwhich ${state}!`;
    if (session.okToReverse(message)) session.reverse = !session.reverse;
  }
  return looksReversed;
}

/** GNU's `best_name`, including its running minimums. */
function bestName(
  names: readonly (string | null)[],
  ignore: readonly boolean[],
  valid: (name: string) => boolean,
): number {
  const counts: Array<number | undefined> = [];
  const basenames: Array<number | undefined> = [];
  const lengths: Array<number | undefined> = [];
  let fewest = Number.POSITIVE_INFINITY;
  let shortestBase = Number.POSITIVE_INFINITY;
  let shortest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 3; index++) {
    const name = names[index];
    if (name === undefined || name === null || ignore[index] === true) continue;
    const count = components(name, null);
    counts[index] = count;
    if (fewest < count) continue;
    fewest = count;
    const base = name.slice(name.lastIndexOf("/") + 1).length;
    basenames[index] = base;
    if (shortestBase < base) continue;
    shortestBase = base;
    lengths[index] = name.length;
    if (shortest < name.length) continue;
    shortest = name.length;
  }
  for (let index = 0; index < 3; index++) {
    const name = names[index];
    if (
      name !== undefined &&
      name !== null &&
      ignore[index] !== true &&
      valid(name) &&
      counts[index] === fewest &&
      basenames[index] === shortestBase &&
      lengths[index] === shortest
    ) {
      return index;
    }
  }
  return NONE;
}

/** Directory components of a name; with a filesystem, only the leading ones that exist. */
function components(name: string, fs: BoundedFs | null, session?: Session): number {
  let count = 0;
  for (let index = 1; index < name.length; index++) {
    if (name.charAt(index) !== "/" || name.charAt(index - 1) === "/") continue;
    if (fs !== null && session !== undefined) {
      const stat = fs.stat(session.publisher.path(name.slice(0, index)));
      if (stat?.type !== "dir") break;
    }
    count++;
  }
  return count;
}

/** GNU's `name_is_valid`: relative and free of `..`, remembered per patch. */
function validator(session: Session): (name: string) => boolean {
  const invalid: string[] = [];
  return (name) => {
    if (invalid.includes(name)) return false;
    const safe = !name.startsWith("/") && !name.split("/").includes("..");
    if (safe || session.options.cwd === "/") return true;
    session.say(`Ignoring potentially dangerous file name ${quote(name)}\n`);
    if (invalid.length < 2) invalid.push(name);
    return false;
  };
}
