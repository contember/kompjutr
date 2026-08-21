// Argv parsing shared by the flag surfaces.
//
// Deliberately small: it knows how flags are *spelled*, not what any of them
// mean. Which flags exist and what they do is the surface's business, and
// keeping that out of here is what lets `grep` and `rg` disagree.

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface FlagSpec {
  /** Flags taking a value: `-A 3`, `-A3`, `--include=x`, `--include x`. */
  readonly valued: ReadonlySet<string>;
  /** Flags that are on/off and may be bundled: `-rn` is `-r -n`. */
  readonly boolean: ReadonlySet<string>;
}

export interface ParsedArgs {
  /** Flag occurrences in order. A boolean flag carries `null`. */
  readonly flags: ReadonlyArray<{ name: string; value: string | null }>;
  readonly operands: readonly string[];
}

export function parseFlags(argv: readonly string[], spec: FlagSpec): ParsedArgs {
  const flags: Array<{ name: string; value: string | null }> = [];
  const operands: string[] = [];
  let index = 0;

  const take = (name: string): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`option requires an argument -- ${name}`);
    index++;
    return value;
  };

  for (; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (arg === "--") {
      operands.push(...argv.slice(index + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (spec.valued.has(name)) {
        flags.push({ name, value: equals === -1 ? take(name) : arg.slice(equals + 1) });
        continue;
      }
      if (spec.boolean.has(name)) {
        flags.push({ name, value: null });
        continue;
      }
      throw new UsageError(`unrecognized option '${arg}'`);
    }

    if (arg.startsWith("-") && arg.length > 1) {
      // A bundle: every character is a flag until one takes a value, and
      // the rest of the bundle is that value (`-A3`, `-n5`).
      let cursor = 1;
      while (cursor < arg.length) {
        const name = `-${arg.charAt(cursor)}`;
        if (spec.valued.has(name)) {
          const inline = arg.slice(cursor + 1);
          flags.push({ name, value: inline === "" ? take(name) : inline });
          cursor = arg.length;
          continue;
        }
        if (!spec.boolean.has(name)) throw new UsageError(`invalid option -- '${name.slice(1)}'`);
        flags.push({ name, value: null });
        cursor++;
      }
      continue;
    }

    operands.push(arg);
  }

  return { flags, operands };
}

export function count(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`invalid ${flag} argument '${value}'`);
  }
  return parsed;
}
