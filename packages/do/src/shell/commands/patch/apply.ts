// Applying one file's hunks in order.
//
// Hunks are read one at a time, so a malformed hunk stops the run only after
// the earlier ones were reported. The first hunk that fits nowhere is also
// tried reversed at each fuzz level: a patch that was already applied, or a
// reversed one, is noticed there and handled as the answers allow.
//
// Line numbers GNU reports are in the new file: a hunk's own line moved by
// the lines earlier hunks added or removed. The offset it reports is against
// the hunk's own line, not against the guess.

import { type Hunk, reversed } from "./hunk.js";
import { atGuess, type FileLines, Pattern, type Placement, search, usefulFuzz } from "./locate.js";
import { Plan, type Reject } from "./output.js";
import { plural, type Report } from "./report.js";

export interface ApplySettings {
  readonly reverse: boolean;
  /** False after `-f`, or once a create/delete question already decided the direction. */
  readonly detectReverse: boolean;
  readonly answers: "ask" | "batch" | "force";
  readonly forward: boolean;
  readonly maxFuzz: number;
}

export interface Applied {
  readonly plan: Plan;
  readonly rejects: readonly Reject[];
  readonly total: number;
  /** Every hunk was set aside after a reversed patch was detected. */
  readonly skipped: boolean;
  /** Some hunk needed an offset, fuzz, or the other direction, or failed. */
  readonly mismatch: boolean;
  readonly reverse: boolean;
}

export function applyHunks(
  file: FileLines,
  nextHunk: () => Hunk | null,
  settings: ApplySettings,
  report: Report,
): Applied {
  const plan = new Plan();
  const rejects: Reject[] = [];
  const lines = file.count;
  let reverse = settings.reverse;
  let skipped = false;
  let mismatch = false;
  let total = 0;
  let shift = 0;
  let lastOffset = 0;
  let floor = 0;

  for (let parsed = nextHunk(); parsed !== null; parsed = nextHunk()) {
    total++;
    const hunk = reverse ? reversed(parsed) : parsed;
    if (skipped) {
      rejects.push({ hunk, shift: 0 });
      continue;
    }
    let pattern = new Pattern(hunk);
    let placement = find(file, pattern, lastOffset, floor, settings.maxFuzz, (fuzz) => {
      if (total !== 1 || !settings.detectReverse) return null;
      const other = new Pattern(reversed(hunk));
      const found = findAt(file, other, lastOffset, floor, fuzz);
      if (found === null) return null;
      const detected = reverse
        ? "Unreversed patch detected!  "
        : "Reversed (or previously applied) patch detected!  ";
      if (settings.forward) {
        report.always(`${detected}Skipping patch.\n`);
        skipped = true;
      } else if (settings.answers === "batch") {
        report.always(`${detected}${reverse ? "Ignoring -R." : "Assuming -R."}\n`);
        reverse = !reverse;
        mismatch = true;
        pattern = other;
        return found;
      } else {
        report.always(`${detected}${reverse ? "Ignore -R? [n] " : "Assume -R? [n] "}\n`);
        report.always("Apply anyway? [n] \n");
        report.verbose("Skipping patch.\n");
        skipped = true;
      }
      return "stop";
    });
    if (skipped) {
      rejects.push({ hunk, shift: 0 });
      continue;
    }
    const applying = pattern.hunk;
    if (placement !== null && placement.at < floor) {
      report.always("misordered hunks! output would be garbled\n");
      report.verbose(`Hunk #${total} FAILED at ${placement.at + 1 + shift}.\n`);
      rejects.push({ hunk: applying, shift });
      mismatch = true;
      placement = null;
      continue;
    }
    if (placement === null) {
      const endings = differentEndings(file, pattern) ? " (different line endings)" : "";
      report.verbose(`Hunk #${total} FAILED at ${applying.oldFirst + shift}${endings}.\n`);
      rejects.push({ hunk: applying, shift });
      mismatch = true;
      continue;
    }

    const offset = placement.at - (applying.oldFirst - 1);
    lastOffset = offset;
    if (offset !== 0 || placement.fuzz > 0) {
      mismatch = true;
      const fuzz = placement.fuzz > 0 ? ` with fuzz ${placement.fuzz}` : "";
      const moved = offset !== 0 ? ` (offset ${plural(offset, "line")})` : "";
      report.verbose(`Hunk #${total} succeeded at ${placement.at + 1 + shift}${fuzz}${moved}.\n`);
    }
    plan.copy(floor, Math.min(placement.at, lines));
    // Trailing context is left to the file, so the next hunk may start on it.
    const kept = pattern.old.length - pattern.suffix;
    let oldIndex = 0;
    for (const entry of applying.lines) {
      if (entry.kind === "+") {
        plan.add(entry.line);
        shift++;
        continue;
      }
      if (oldIndex >= kept) break;
      const at = placement.at + oldIndex;
      if (entry.kind === " " && at < lines) plan.copy(at, at + 1);
      if (entry.kind === "-") shift--;
      oldIndex++;
    }
    floor = Math.max(floor, placement.at + kept);
  }
  plan.copy(floor, lines);
  return { plan, rejects, total, skipped, mismatch, reverse };
}

type ReverseCheck = (fuzz: number) => Placement | "stop" | null;

function find(
  file: FileLines,
  pattern: Pattern,
  lastOffset: number,
  floor: number,
  maxFuzz: number,
  tryReversed: ReverseCheck,
): Placement | null {
  const top = usefulFuzz(pattern, maxFuzz);
  for (let fuzz = 0; fuzz <= top; fuzz++) {
    const found = findAt(file, pattern, lastOffset, floor, fuzz);
    if (found !== null) return found;
    const other = tryReversed(fuzz);
    if (other === "stop") return null;
    if (other !== null) return other;
  }
  return null;
}

function findAt(
  file: FileLines,
  pattern: Pattern,
  lastOffset: number,
  floor: number,
  fuzz: number,
): Placement | null {
  const guess = pattern.hunk.oldFirst - 1 + lastOffset;
  if (fuzz === 0) {
    const exact = atGuess(file, pattern, guess);
    if (exact !== null) return exact;
  }
  return search(file, pattern, guess, floor, fuzz);
}

function differentEndings(file: FileLines, pattern: Pattern): boolean {
  const first = pattern.old[0];
  if (first === undefined || !file.firstEndsWithCr()) return false;
  return first.bytes[first.bytes.length - 1] !== 0x0d;
}
