// File names as a diff header spells them, and the choice among them.
//
// A header name runs to a tab when the line has one, otherwise to the first
// blank; a double-quoted name uses C escapes. `-pN` strips the shortest
// prefix holding N slashes, runs of slashes counting once; without `-p`
// only the last component remains. Among several candidates the best has the
// fewest components, then the shortest basename, then the shortest name,
// then comes first.

export interface HeaderName {
  readonly name: string;
  /** Whatever followed the name after a tab; the reject file repeats it. */
  readonly stamp: string | null;
}

const DEV_NULL = "/dev/null";
const EPOCH = /^1970-01-01 00:00:00(?:\.0+)? \+0000$/;

export function parseHeaderName(text: string): HeaderName {
  if (text.startsWith('"')) {
    const quoted = unquoteC(text);
    if (quoted !== null) {
      const rest = text.slice(quoted.consumed);
      const tab = rest.indexOf("\t");
      return { name: quoted.value, stamp: tab === -1 ? null : rest.slice(tab + 1) };
    }
  }
  const tab = text.indexOf("\t");
  if (tab !== -1) return { name: text.slice(0, tab), stamp: text.slice(tab + 1) };
  const blank = text.search(/[ \t\r]/);
  return { name: blank === -1 ? text : text.slice(0, blank), stamp: null };
}

/** True when a header name says the file does not exist on that side. */
export function namesAbsentFile(header: HeaderName | null): boolean {
  if (header === null) return false;
  return header.name === DEV_NULL || (header.stamp !== null && EPOCH.test(header.stamp.trim()));
}

/** A C-quoted string at the start of `text`, as git writes unusual names. */
export function unquoteC(text: string): { value: string; consumed: number } | null {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let index = 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === '"') {
      return { value: new TextDecoder().decode(Uint8Array.from(bytes)), consumed: index + 1 };
    }
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      index++;
      continue;
    }
    const escaped = text.charAt(index + 1);
    const octal = /^[0-7]{3}/.exec(text.slice(index + 1));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8) & 0xff);
      index += 4;
      continue;
    }
    const simple: Record<string, number> = {
      a: 7,
      b: 8,
      f: 12,
      n: 10,
      r: 13,
      t: 9,
      v: 11,
      "\\": 92,
      '"': 34,
    };
    const code = simple[escaped];
    if (code === undefined) return null;
    bytes.push(code);
    index += 2;
  }
  return null;
}

/** Apply `-pN`; null when the name has too few slashes. */
export function stripName(name: string, strip: number | null): string | null {
  if (strip === null) {
    const slash = name.lastIndexOf("/");
    return slash === -1 ? name : name.slice(slash + 1);
  }
  let rest = name;
  for (let removed = 0; removed < strip; removed++) {
    const slash = rest.indexOf("/");
    if (slash === -1) return null;
    let after = slash + 1;
    while (rest.charAt(after) === "/") after++;
    rest = rest.slice(after);
  }
  return rest;
}

/** Absolute, or climbing out through `..`: GNU refuses to touch it. */
export function isDangerous(name: string): boolean {
  return name.startsWith("/") || name.split("/").includes("..");
}

function components(name: string): number {
  return name.split("/").filter((part) => part !== "").length;
}

function basenameLength(name: string): number {
  return name.length - name.lastIndexOf("/") - 1;
}

/** The best of several candidate names, or null when there are none. */
export function bestName(names: readonly string[]): string | null {
  let best: string | null = null;
  for (const name of names) {
    if (best === null || better(name, best)) best = name;
  }
  return best;
}

function better(name: string, than: string): boolean {
  const byComponents = components(name) - components(than);
  if (byComponents !== 0) return byComponents < 0;
  const byBasename = basenameLength(name) - basenameLength(than);
  if (byBasename !== 0) return byBasename < 0;
  return name.length < than.length;
}

/** Split the two names of a `diff --git` line. */
export function gitLineNames(text: string): { old: string; new: string } | null {
  if (text.startsWith('"')) {
    const first = unquoteC(text);
    if (first === null) return null;
    const rest = text.slice(first.consumed).replace(/^ +/, "");
    if (rest.startsWith('"')) {
      const second = unquoteC(rest);
      return second === null ? null : { old: first.value, new: second.value };
    }
    return { old: first.value, new: rest };
  }
  const spaces: number[] = [];
  for (let index = 0; index < text.length; index++)
    if (text.charAt(index) === " ") spaces.push(index);
  for (const space of spaces) {
    const old = text.slice(0, space);
    const rest = text.slice(space + 1);
    if (rest.startsWith('"')) {
      const second = unquoteC(rest);
      if (second !== null) return { old, new: second.value };
    }
    if (withoutFirstComponent(old) === withoutFirstComponent(rest)) return { old, new: rest };
  }
  const first = spaces[0];
  if (first === undefined) return null;
  return { old: text.slice(0, first), new: text.slice(first + 1) };
}

function withoutFirstComponent(name: string): string {
  const slash = name.indexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}
