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

import type { RetainedBudget } from "../../exec/context.js";
import type { FileLines } from "./file-lines.js";
import { ADDED, type Hunk, type HunkStore, REMOVED } from "./hunk.js";
import { atGuess, type Found, Pattern, search, usefulFuzz } from "./locate.js";
import { Plan, Rejects } from "./output.js";
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
  readonly rejects: Rejects;
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
  budget: RetainedBudget,
  store: HunkStore,
): Applied {
  const plan = new Plan(store, budget);
  const rejects = new Rejects(store, budget);
  try {
    return placeHunks(file, nextHunk, settings, report, budget, plan, rejects);
  } catch (error) {
    plan.release();
    rejects.release();
    throw error;
  }
}

function placeHunks(
  file: FileLines,
  nextHunk: () => Hunk | null,
  settings: ApplySettings,
  report: Report,
  budget: RetainedBudget,
  plan: Plan,
  rejects: Rejects,
): Applied {
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
    const hunk = reverse ? parsed.reversed() : parsed;
    if (skipped) {
      rejects.add(hunk, 0);
      continue;
    }
    const forward = new Pattern(hunk, budget);
    let pattern = forward;
    // The reversed pattern, built only when the first hunk is checked for reversal.
    const reversedPatterns: Pattern[] = [];
    try {
      const found = find(file, pattern, lastOffset, floor, settings.maxFuzz, (fuzz) => {
        if (total !== 1 || !settings.detectReverse) return null;
        let other = reversedPatterns[0];
        if (other === undefined) {
          other = new Pattern(hunk.reversed(), budget);
          reversedPatterns.push(other);
        }
        const reversedFound = findAt(file, other, lastOffset, floor, fuzz);
        if (reversedFound?.kind !== "placed") return null;
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
          return reversedFound;
        } else {
          report.always(`${detected}${reverse ? "Ignore -R? [n] " : "Assume -R? [n] "}\n`);
          report.always("Apply anyway? [n] \n");
          report.verbose("Skipping patch.\n");
          skipped = true;
        }
        return "stop";
      });
      if (skipped) {
        rejects.add(hunk, 0);
        continue;
      }
      const applying = pattern.hunk;
      if (found?.kind === "misordered") {
        report.always("misordered hunks! output would be garbled\n");
        report.verbose(`Hunk #${total} FAILED at ${found.at + 1 + shift}.\n`);
        rejects.add(applying, shift);
        mismatch = true;
        continue;
      }
      if (found === null) {
        const endings =
          pattern.length > 0 && lines > 0 && file.firstEndsWithCr() !== pattern.firstEndsWithCr()
            ? " (different line endings)"
            : "";
        report.verbose(`Hunk #${total} FAILED at ${applying.oldFirst + shift}${endings}.\n`);
        rejects.add(applying, shift);
        mismatch = true;
        continue;
      }

      const offset = found.at - (applying.oldFirst - 1);
      lastOffset = offset;
      if (offset !== 0 || found.fuzz > 0) {
        mismatch = true;
        const fuzz = found.fuzz > 0 ? ` with fuzz ${found.fuzz}` : "";
        const moved = offset !== 0 ? ` (offset ${plural(offset, "line")})` : "";
        report.verbose(`Hunk #${total} succeeded at ${found.at + 1 + shift}${fuzz}${moved}.\n`);
      }
      plan.copy(floor, Math.min(found.at, lines));
      // Trailing context is left to the file, so the next hunk may start on it.
      const kept = pattern.length - pattern.suffix;
      plan.place(applying, found.at, kept, floor, lines);
      for (let index = 0; index < applying.count; index++) {
        const kind = applying.kind(index);
        if (kind === ADDED) shift++;
        else if (kind === REMOVED) shift--;
      }
      floor = Math.max(floor, found.at + kept);
    } finally {
      forward.release();
      for (const other of reversedPatterns) other.release();
    }
  }
  plan.copy(floor, lines);
  return { plan, rejects, total, skipped, mismatch, reverse };
}

type ReverseCheck = (fuzz: number) => Found | "stop" | null;

function find(
  file: FileLines,
  pattern: Pattern,
  lastOffset: number,
  floor: number,
  maxFuzz: number,
  tryReversed: ReverseCheck,
): Found | null {
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
): Found | null {
  const guess = pattern.hunk.oldFirst - 1 + lastOffset;
  if (fuzz === 0) {
    const exact = atGuess(file, pattern, guess, floor);
    if (exact !== null) return exact;
  }
  return search(file, pattern, guess, floor, fuzz);
}
