// Random git operation sequences, played on kompjutr's local composition and
// on the real git binary, compared after every op. A failing seed is shrunk
// to a minimal repro and printed as a replayable scenario.
//
//   KOMPJUTR_DIFF_SEEDS=2000 KOMPJUTR_DIFF_STEPS=80 npx vitest run tests/differential/random.test.ts
//
// explores further; KOMPJUTR_DIFF_FIRST_SEED moves the window. A printed
// repro replays as a scenario in regressions-<topic>.test.ts.

import { appendFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";
import { knownDivergence } from "../helpers/differential/known.js";
import { explore, report, shrink } from "../helpers/differential/run.js";

const FIRST = Number(process.env.KOMPJUTR_DIFF_FIRST_SEED ?? 1);
const SEEDS = Number(process.env.KOMPJUTR_DIFF_SEEDS ?? 40);
const STEPS = Number(process.env.KOMPJUTR_DIFF_STEPS ?? 30);
/** Exploration appends one JSON line per diverging seed here. */
const REPORT = process.env.KOMPJUTR_DIFF_REPORT;
/** Shrinking shares the 60 s test budget with generation. */
const SHRINK_MS = 40_000;
/**
 * A known divergence ends its seed early, so the fixed CI set must still play
 * this share of its ops; otherwise known entries silently hollow it out.
 */
const COVERAGE_FLOOR = 0.6;
const CI_SET = FIRST === 1 && SEEDS === 40 && STEPS === 30;

describe("differential: kompjutr local vs git", () => {
  const seeds = Array.from({ length: SEEDS }, (_, index) => FIRST + index);
  let played = 0;
  let finished = 0;
  afterAll(() => {
    if (!CI_SET || finished !== SEEDS) return;
    expect(played / (SEEDS * STEPS)).toBeGreaterThanOrEqual(COVERAGE_FLOOR);
  });
  it.each(seeds)("seed %i", async (seed) => {
    const result = await explore(seed, STEPS);
    played += result.scenario.ops.length;
    finished++;
    if (result.divergence === null) return;
    const known = knownDivergence(result.divergence);
    if (known !== undefined) {
      if (REPORT !== undefined)
        appendFileSync(
          REPORT,
          `${JSON.stringify({ seed, known: known.id, step: result.divergence.step + 1 })}\n`,
        );
      return;
    }
    const shrunk = await shrink(result, Date.now() + SHRINK_MS);
    const text = report(seed, result, shrunk);
    if (REPORT !== undefined) appendFileSync(REPORT, `${JSON.stringify({ seed, text })}\n`);
    expect.fail(text);
  });
});
