// One `.gitignore` line, compiled.
//
// Semantics per gitignore(5): a leading `!` negates, a trailing `/` matches
// directories only, a `/` anywhere but the end anchors the pattern to the
// directory holding the file, `*` and `?` never cross a `/`, and `**`
// does.

export interface IgnorePattern {
  negated: boolean;
  directoryOnly: boolean;
  test: (relative: string) => boolean;
}

const SPECIAL = /[.+^${}()|[\]\\]/g;

/** Compile a pattern, or null for a blank or comment line. */
export function compilePattern(line: string): IgnorePattern | null {
  let pattern = stripTrailingSpaces(line);
  if (pattern === "" || pattern.startsWith("#")) return null;

  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }

  let directoryOnly = false;
  if (pattern.endsWith("/")) {
    directoryOnly = true;
    pattern = pattern.slice(0, -1);
  }
  if (pattern === "") return null;

  // A slash anywhere except the very end anchors the pattern; a leading
  // slash anchors it and is not part of the match.
  const anchored = pattern.slice(0, -1).includes("/") || pattern.startsWith("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);

  const source = `^${anchored ? "" : "(?:.*/)?"}${globToRegex(pattern)}$`;
  const regex = new RegExp(source);
  return { negated, directoryOnly, test: (relative) => regex.test(relative) };
}

/** Trailing whitespace is ignored unless the last space is escaped. */
function stripTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " " && !isEscaped(line, end - 1)) end--;
  return line.slice(0, end);
}

function isEscaped(line: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && line[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}

function globToRegex(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i]!;
    if (char === "\\" && i + 1 < pattern.length) {
      out += pattern[i + 1]!.replace(SPECIAL, "\\$&");
      i += 2;
      continue;
    }
    if (char === "*") {
      const doubled = pattern[i + 1] === "*";
      if (doubled) {
        const before = i === 0 || pattern[i - 1] === "/";
        const after = i + 2 >= pattern.length || pattern[i + 2] === "/";
        if (before && after) {
          if (i + 2 >= pattern.length) {
            // trailing `/**`: everything below
            out += ".*";
            i += 2;
          } else {
            // `**/`: zero or more directories
            out += "(?:.*/)?";
            i += 3;
          }
          continue;
        }
        // `**` not on its own segment behaves like a single `*`
        out += "[^/]*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (char === "[") {
      const close = findClassEnd(pattern, i);
      if (close > 0) {
        out += translateClass(pattern.slice(i, close + 1));
        i = close + 1;
        continue;
      }
      out += "\\[";
      i += 1;
      continue;
    }
    out += char.replace(SPECIAL, "\\$&");
    i += 1;
  }
  return out;
}

function findClassEnd(pattern: string, start: number): number {
  let i = start + 1;
  if (pattern[i] === "!" || pattern[i] === "^") i++;
  if (pattern[i] === "]") i++;
  while (i < pattern.length && pattern[i] !== "]") i++;
  return i < pattern.length ? i : -1;
}

function translateClass(source: string): string {
  const body = source.slice(1, -1);
  const negated = body.startsWith("!") || body.startsWith("^");
  const rest = negated ? body.slice(1) : body;
  // A class never matches a path separator, negated or not.
  return `[${negated ? "^/" : ""}${rest.replace(/\\/g, "\\\\")}]`;
}
