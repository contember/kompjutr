// The scenario registry. Synthetic trees isolate one variable at a time;
// the macro suite replays the reference experiment's operations against
// real repositories.

import { MACRO } from "./macro.js";
import { SYNTHETIC } from "./synthetic.js";

export type {
  Backend,
  Harness,
  Phase,
  Scenario,
  ScenarioContext,
  Shape,
  Variant,
} from "./harness.js";
export { asVariant, fixtureNameOf, harness, isShape, shapeOf } from "./harness.js";
export { FILE_BYTES, pathFor, writeFiles } from "./synthetic.js";

export const SCENARIOS = [...SYNTHETIC, ...MACRO];
