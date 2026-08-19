// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Ported from the xdiff library as it appears in git, which derives from
// LibXDiff, Copyright (C) 2003 Davide Libenzi <davidel@xmailserver.org>.
// LGPL-2.1-or-later, like the original. See ./LICENSE — this directory is
// the one part of kompjutr that is not MIT.

// Turning bytes into the line records git's differ works on.

/**
 * Split text into records the way git does: each record keeps its own
 * trailing newline, and a final record without one is what makes
 * `\ No newline at end of file` appear in a patch.
 */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      lines.push(text.slice(start));
      return lines;
    }
    lines.push(text.slice(start, newline + 1));
    start = newline + 1;
    if (start === text.length) return lines;
  }
}

/** How much of a file git inspects before calling it binary. */
const FIRST_FEW_BYTES = 8000;

/** git's test: a NUL byte anywhere near the start means "binary". */
export function isBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, FIRST_FEW_BYTES);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
  return false;
}
