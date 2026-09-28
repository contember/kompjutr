// chmod's mode operand: an octal number, or the symbolic grammar POSIX
// specifies for chmod (clauses of an optional who list and one or more
// actions, separated by commas). Two extensions follow the host chmod's
// observed behaviour: an octal number after an operator (`=0`, `+0`), and a
// directory's set-user-ID and set-group-ID bits surviving any change that
// does not name them, including an octal mode of four digits or fewer.

const SETUID = 0o4000;
const SETGID = 0o2000;
const STICKY = 0o1000;
const SET_IDS = SETUID | SETGID;
const ALL = 0o7777;

/** Each class owns its rwx triple plus the special bit that belongs to it. */
const CLASS_BITS: Readonly<Record<string, number>> = {
  u: SETUID | 0o700,
  g: SETGID | 0o070,
  o: STICKY | 0o007,
  a: ALL,
};
const PERM_BITS: Readonly<Record<string, number>> = {
  r: 0o444,
  w: 0o222,
  x: 0o111,
  s: SET_IDS,
  t: STICKY,
};
const CLASS_SHIFT: Readonly<Record<string, number>> = { u: 6, g: 3, o: 0 };

/** What an action writes: literal bits, a copy of one class, or an absolute number. */
type Operand =
  | { readonly kind: "perms"; readonly bits: number; readonly conditionalExecute: boolean }
  | { readonly kind: "copy"; readonly shift: number }
  | { readonly kind: "number"; readonly bits: number; readonly keepsDirectoryIds: boolean };

interface Action {
  readonly op: "+" | "-" | "=";
  readonly operand: Operand;
}

interface Clause {
  /** Bits the who list selects; null when no who was written. */
  readonly who: number | null;
  readonly actions: readonly Action[];
}

export type ModeChanges = readonly Clause[];

/** Parse a mode operand; null when chmod would reject it as invalid. */
export function compileMode(mode: string): ModeChanges | null {
  if (/^[0-7]+$/.test(mode)) {
    const bits = Number.parseInt(mode, 8);
    if (bits > ALL) return null;
    const operand: Operand = { kind: "number", bits, keepsDirectoryIds: mode.length <= 4 };
    return [{ who: null, actions: [{ op: "=", operand }] }];
  }
  const clauses: Clause[] = [];
  for (const text of mode.split(",")) {
    const clause = parseClause(text);
    if (clause === null) return null;
    clauses.push(clause);
  }
  return clauses;
}

function parseClause(text: string): Clause | null {
  let at = 0;
  let who: number | null = null;
  while (at < text.length && CLASS_BITS[text.charAt(at)] !== undefined) {
    who = (who ?? 0) | (CLASS_BITS[text.charAt(at)] ?? 0);
    at++;
  }

  const actions: Action[] = [];
  while (at < text.length) {
    const op = text.charAt(at);
    if (op !== "+" && op !== "-" && op !== "=") return null;
    at++;
    const next = text.charAt(at);

    if (/[0-7]/.test(next)) {
      const digits = /^[0-7]+/.exec(text.slice(at))?.[0] ?? "";
      const bits = Number.parseInt(digits, 8);
      at += digits.length;
      if (who !== null || at !== text.length || bits > ALL) return null;
      actions.push({ op, operand: { kind: "number", bits, keepsDirectoryIds: false } });
      continue;
    }

    const shift = CLASS_SHIFT[next];
    if (shift !== undefined) {
      actions.push({ op, operand: { kind: "copy", shift } });
      at++;
      continue;
    }

    let bits = 0;
    let conditionalExecute = false;
    for (; at < text.length; at++) {
      const perm = text.charAt(at);
      if (perm === "X") conditionalExecute = true;
      else if (PERM_BITS[perm] !== undefined) bits |= PERM_BITS[perm] ?? 0;
      else break;
    }
    actions.push({ op, operand: { kind: "perms", bits, conditionalExecute } });
  }
  return actions.length === 0 ? null : { who, actions };
}

/** The permission bits a file with `oldMode` has after `changes`. */
export function adjustMode(
  oldMode: number,
  directory: boolean,
  umask: number,
  changes: ModeChanges,
): number {
  let mode = oldMode & ALL;
  for (const clause of changes) {
    // Without a who list the clause reaches every class, less what the umask hides.
    const scope = clause.who ?? ALL & ~umask;
    for (const action of clause.actions) {
      mode = applyAction(mode, directory, clause.who, scope, action);
    }
  }
  return mode;
}

function applyAction(
  mode: number,
  directory: boolean,
  who: number | null,
  scope: number,
  action: Action,
): number {
  const { operand } = action;
  let bits: number;
  if (operand.kind === "number") {
    bits = operand.bits;
  } else {
    bits = operand.kind === "copy" ? replicate(mode, operand.shift) : operand.bits;
    if (operand.kind === "perms" && operand.conditionalExecute) {
      if (directory || (mode & 0o111) !== 0) bits |= 0o111;
    }
    bits &= scope;
  }

  // A directory keeps its set-ID bits unless this action writes them explicitly.
  let untouchable = 0;
  if (directory) {
    const named =
      operand.kind === "number"
        ? operand.keepsDirectoryIds
          ? operand.bits & SET_IDS
          : SET_IDS
        : bits & SET_IDS;
    untouchable = SET_IDS & ~named;
  }
  bits &= ~untouchable;

  if (action.op === "+") return mode | bits;
  if (action.op === "-") return mode & ~bits;
  // `=` clears what the who list selects; an absent who list clears every class.
  const cleared = operand.kind === "number" ? ALL : (who ?? ALL);
  return (mode & ~(cleared & ~untouchable)) | bits;
}

/** The rwx triple at `shift`, copied into all three classes. */
function replicate(mode: number, shift: number): number {
  const triple = (mode >> shift) & 0o7;
  return (triple << 6) | (triple << 3) | triple;
}

/** `rwxr-sr-t`: the nine permission characters `ls -l` and chmod -v print. */
export function permissionString(mode: number): string {
  const triple = (shift: number, special: number, set: string, unset: string): string => {
    const bits = (mode >> shift) & 0o7;
    const execute = (bits & 1) !== 0;
    const specialSet = (mode & special) !== 0;
    return (
      ((bits & 4) !== 0 ? "r" : "-") +
      ((bits & 2) !== 0 ? "w" : "-") +
      (specialSet ? (execute ? set : unset) : execute ? "x" : "-")
    );
  };
  return triple(6, SETUID, "s", "S") + triple(3, SETGID, "s", "S") + triple(0, STICKY, "t", "T");
}

export function octalMode(mode: number): string {
  return (mode & ALL).toString(8).padStart(4, "0");
}
