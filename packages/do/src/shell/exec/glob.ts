// Glob matching, and the lowering that decides whether SQLite can do it.
//
// Two dialects meet here and they disagree in one important place: SQLite's
// GLOB lets `*` cross a `/`, and a shell's does not. `ls /repo/*.ts` must not
// return `/repo/a/b.ts`. So a SQL GLOB is used to *narrow* — it is always a
// superset — and the exact answer is decided in JS.

import { GLOB_PATTERN_MAX_BYTES } from "../../fs/store/scan.js";

export { GLOB_PATTERN_MAX_BYTES };

interface Matcher {
  test(path: string): boolean;
}

/** Compile a pathname glob with Bash's default `globstar` and `dotglob` disabled. */
export function compileGlob(pattern: string): Matcher {
  return { test: buildRegExp(pattern, false, true) };
}

/**
 * A matcher for `--include`/`-g`: matched against the basename when the
 * pattern has no `/`, and against the whole path when it does. That is what
 * both grep and rg do, and it is why `--include='*.ts'` finds nested files.
 */
export function compileIncludeGlob(pattern: string): Matcher {
  const test = buildRegExp(pattern, true, false);
  if (!pattern.includes("/")) {
    return {
      test: (path: string) => test(path.slice(path.lastIndexOf("/") + 1)),
    };
  }
  return { test };
}

function buildRegExp(
  pattern: string,
  recursiveStars: boolean,
  protectLeadingDots: boolean,
): (value: string) => boolean {
  let source = "";
  let index = 0;
  let componentStart = true;
  while (index < pattern.length) {
    const char = pattern.charAt(index);
    if (char === "/") {
      source += "/";
      index++;
      componentStart = true;
      continue;
    }
    if (componentStart && protectLeadingDots && char !== ".") source += "(?!\\.)";
    componentStart = false;
    if (char === "*") {
      if (recursiveStars && pattern.charAt(index + 1) === "*") {
        // `**` crosses separators; `**/` also matches zero directories.
        if (pattern.charAt(index + 2) === "/") {
          source += "(?:.*/)?";
          index += 3;
          componentStart = true;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
      do index++;
      while (!recursiveStars && pattern.charAt(index) === "*");
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index++;
      continue;
    }
    if (char === "[") {
      const close = pattern.indexOf("]", index + 2);
      if (close !== -1) {
        const body = pattern.slice(index + 1, close);
        const negated = body.startsWith("!") || body.startsWith("^");
        source += `[${negated ? "^" : ""}${escapeClass(negated ? body.slice(1) : body)}]`;
        index = close + 1;
        continue;
      }
    }
    source += escapeLiteral(char);
    index++;
  }
  const regexp = new RegExp(`^${source}$`, "u");
  return (value: string) => regexp.test(value);
}

function escapeLiteral(char: string): string {
  return /[\\^$.|?*+()[\]{}]/.test(char) ? `\\${char}` : char;
}

function escapeClass(body: string): string {
  return body.replace(/[\\\]]/g, (match) => `\\${match}`);
}

/**
 * The SQL GLOB to narrow with, or null when the pattern would exceed the
 * platform's 50-byte ceiling and the caller must fall back to a scan.
 *
 * The returned pattern is deliberately *looser* than the shell's: `[^/]*`
 * has no SQL GLOB equivalent, so `*` is emitted as `*` and the caller
 * filters. Never the other way round — a tighter SQL pattern would drop
 * real matches before JS could see them.
 */
export function sqlGlobFor(absolutePattern: string): string | null {
  const bytes = new TextEncoder().encode(absolutePattern).length;
  return bytes > GLOB_PATTERN_MAX_BYTES ? null : absolutePattern;
}
