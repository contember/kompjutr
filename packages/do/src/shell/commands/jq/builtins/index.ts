// The global function table: natives plus the parsed prelude, built once.

import type { Native } from "../runtime.js";
import type { Definition } from "../syntax/ast.js";
import { parseDefinitions } from "../syntax/parser.js";
import { registerCore } from "./core.js";
import { registerDates } from "./dates.js";
import { registerFlow } from "./flow.js";
import type { Natives } from "./native.js";
import { PRELUDE, REFUSED_BUILTINS } from "./prelude.js";
import { registerRegex } from "./regex.js";
import { registerStrings } from "./strings.js";
import { registerStructure } from "./structure.js";

let table: ReadonlyMap<string, Native | Definition> | null = null;

export function globals(): ReadonlyMap<string, Native | Definition> {
  if (table !== null) return table;
  const natives: Natives = new Map();
  registerCore(natives);
  registerFlow(natives);
  registerStrings(natives);
  registerRegex(natives);
  registerDates(natives);
  registerStructure(natives);
  const built = new Map<string, Native | Definition>(natives);
  for (const definition of parseDefinitions(PRELUDE)) {
    built.set(`${definition.name}/${definition.params.length}`, definition);
  }
  table = built;
  return built;
}

export const REFUSED: ReadonlySet<string> = new Set(REFUSED_BUILTINS);
