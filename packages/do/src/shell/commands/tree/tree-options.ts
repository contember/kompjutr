// tree's admitted flags. Its own parser takes a value from the rest of the
// bundle or the next word, reads `-L` with atoi, and reports its own
// diagnostics; every flag outside the admitted set is refused, not ignored.

export class TreeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreeUsageError";
  }
}

export type Charset = "ascii" | "utf8";

export interface TreeOptions {
  readonly all: boolean;
  readonly directoriesOnly: boolean;
  readonly level: number | null;
  readonly fullPath: boolean;
  readonly classify: boolean;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly noReport: boolean;
  readonly directoriesFirst: boolean;
  readonly noIndent: boolean;
  readonly charset: Charset;
  readonly operands: readonly string[];
}

const SWITCHES = new Set(["a", "d", "f", "F", "i"]);
const VALUED = new Set(["L", "P", "I"]);

export function parseTreeOptions(argv: readonly string[]): TreeOptions {
  const switches = new Set<string>();
  const include: string[] = [];
  const exclude: string[] = [];
  const operands: string[] = [];
  let level: number | null = null;
  let noReport = false;
  let directoriesFirst = false;
  let charset: Charset = "ascii";

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      operands.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (name === "--noreport" && equals === -1) noReport = true;
      else if (name === "--dirsfirst" && equals === -1) directoriesFirst = true;
      else if (name === "--charset") {
        let value: string | undefined = arg.slice(equals + 1);
        if (equals === -1) value = argv[++index];
        if (value === undefined) throw new TreeUsageError("Missing argument to --charset");
        charset = parseCharset(value);
      } else {
        throw new TreeUsageError(`unsupported option '${arg}'`);
      }
      continue;
    }
    if (!arg.startsWith("-") || arg.length === 1) {
      operands.push(arg);
      continue;
    }
    for (let cursor = 1; cursor < arg.length; cursor++) {
      const flag = arg.charAt(cursor);
      if (SWITCHES.has(flag)) {
        switches.add(flag);
        continue;
      }
      if (!VALUED.has(flag)) throw new TreeUsageError(`unsupported option '-${flag}'`);
      let value: string | undefined = arg.slice(cursor + 1);
      if (value === "") value = argv[++index];
      if (value === undefined) throw new TreeUsageError(`Missing argument to -${flag} option.`);
      cursor = arg.length;
      if (flag === "L") level = parseLevel(value);
      else if (flag === "P") include.push(value);
      else exclude.push(value);
    }
  }

  return {
    all: switches.has("a"),
    directoriesOnly: switches.has("d"),
    level,
    fullPath: switches.has("f"),
    // tree prints no `-F` suffix at all in `-d` mode.
    classify: switches.has("F") && !switches.has("d"),
    include,
    exclude,
    noReport,
    directoriesFirst,
    noIndent: switches.has("i"),
    charset,
    operands: operands.length === 0 ? ["."] : operands,
  };
}

/** C `atoi`: leading blanks, an optional sign, then digits; anything else reads as 0. */
function parseLevel(value: string): number {
  const digits = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(value)?.[1];
  const level = digits === undefined ? 0 : Number.parseInt(digits, 10);
  if (level < 1) throw new TreeUsageError("Invalid level, must be greater than 0.");
  return level;
}

function parseCharset(value: string): Charset {
  const name = value.toLowerCase();
  if (name === "utf-8" || name === "utf8") return "utf8";
  if (name === "ascii" || name === "us-ascii") return "ascii";
  throw new TreeUsageError(`unsupported charset '${value}'`);
}
