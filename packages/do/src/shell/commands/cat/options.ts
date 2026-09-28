// `cat`'s option surface, as uutils cat 0.2.2 spells it. `-u` is accepted
// and ignored there too. `--help` and `--version` describe the host binary,
// so they are refused rather than invented.

import { UsageError } from "../flags.js";
import {
  type CommandSpec,
  has,
  type ParsedArguments,
  parseArguments,
} from "../uutils/arguments.js";
import type { RenderOptions } from "./render.js";

const SPEC: CommandSpec = {
  name: "cat",
  options: [
    { id: "A", short: "A", long: "show-all", value: "none", display: "--show-all" },
    { id: "b", short: "b", long: "number-nonblank", value: "none", display: "--number-nonblank" },
    { id: "e", short: "e", value: "none", display: "-e" },
    { id: "E", short: "E", long: "show-ends", value: "none", display: "--show-ends" },
    { id: "n", short: "n", long: "number", value: "none", display: "--number" },
    { id: "s", short: "s", long: "squeeze-blank", value: "none", display: "--squeeze-blank" },
    { id: "t", short: "t", value: "none", display: "-t" },
    { id: "T", short: "T", long: "show-tabs", value: "none", display: "--show-tabs" },
    {
      id: "v",
      short: "v",
      long: "show-nonprinting",
      value: "none",
      display: "--show-nonprinting",
    },
    { id: "u", short: "u", value: "none", display: "-u" },
    { id: "help", short: "h", long: "help", value: "none", display: "--help" },
    { id: "version", short: "V", long: "version", value: "none", display: "--version" },
  ],
};

export interface CatArguments {
  /** Null when no option changes the bytes, so plain `cat` keeps its fast path. */
  readonly render: RenderOptions | null;
  readonly operands: readonly string[];
}

/** Throws `ClapError` for what uutils rejects and `UsageError` for what we refuse. */
export function parseCatArguments(argv: readonly string[]): CatArguments {
  const parsed = parseArguments(argv, SPEC);
  for (const refused of ["help", "version"]) {
    if (has(parsed, refused)) throw new UsageError(`--${refused} is not supported`);
  }
  return { render: renderOptions(parsed), operands: parsed.operands };
}

function renderOptions(parsed: ParsedArguments): RenderOptions | null {
  const on = (...ids: string[]): boolean => ids.some((id) => has(parsed, id));
  const options: RenderOptions = {
    number: on("b") ? "nonblank" : on("n") ? "all" : "none",
    squeeze: on("s"),
    showEnds: on("A", "e", "E"),
    showTabs: on("A", "t", "T"),
    showNonprinting: on("A", "e", "t", "v"),
  };
  const changesBytes =
    options.number !== "none" ||
    options.squeeze ||
    options.showEnds ||
    options.showTabs ||
    options.showNonprinting;
  return changesBytes ? options : null;
}
