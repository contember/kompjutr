// A rejected hunk in GNU patch's unified reject format. The first reject of
// a file carries the patch's headers under the names patch resolved; ranges
// are moved by the offset of the hunks already applied, so they guess where
// the hunk belongs in the patched file. An incomplete line is written
// without its newline and without a marker, as GNU writes it.

import { encode } from "../../exec/bytes.js";
import type { Hunk } from "./hunk.js";
import type { Header } from "./intuit.js";

export function rejectHunk(
  hunk: Hunk,
  header: Header,
  outOffset: number,
  withHeader: boolean,
  reverse: boolean,
): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (withHeader) {
    const index = header.names[2];
    if (index !== null) out.push(encode(`Index: ${index}\n`));
    out.push(...headerLine("--- ", header, reverse ? 1 : 0));
    out.push(...headerLine("+++ ", header, reverse ? 0 : 1));
  }
  out.push(
    encode(
      `@@ -${range(hunk.first + outOffset, hunk.old.length)} +${range(
        hunk.newFirst + outOffset,
        hunk.added.length,
      )} @@`,
    ),
  );
  if (hunk.heading !== null) out.push(hunk.heading);
  out.push(encode("\n"));

  let old = 0;
  let added = 0;
  for (;;) {
    for (; hunk.old[old]?.kind === "-"; old++)
      out.push(encode("-"), hunk.old[old]?.bytes ?? encode(""));
    for (; hunk.added[added]?.kind === "+"; added++) {
      out.push(encode("+"), hunk.added[added]?.bytes ?? encode(""));
    }
    // Context lines appear on both sides in the same order.
    const context = hunk.old[old];
    if (context === undefined) break;
    out.push(encode(" "), context.bytes);
    old++;
    added++;
  }
  return out;
}

function headerLine(tag: string, header: Header, side: 0 | 1): Uint8Array[] {
  const name = header.names[side] ?? "/dev/null";
  return [encode(`${tag}${name}`), header.timestr[side] ?? new Uint8Array(0), encode("\n")];
}

/** GNU's `print_unidiff_range`: an empty range names the line before it. */
function range(start: number, count: number): string {
  if (count === 0) return `${start - 1},0`;
  if (count === 1) return `${start}`;
  return `${start},${count}`;
}
