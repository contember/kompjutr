// `sha1sum`, `sha256sum`, `sha512sum` in uutils' shape: options, the output
// line, and the dispatch to `-c`. `md5sum` is absent: crypto.subtle has no MD5.

import { type ByteStream, encode } from "../../exec/bytes.js";
import { type Command, type CommandContext, deferred, fail } from "../../exec/context.js";
import { verify } from "./checksum-check.js";
import { type CommandSpec, conflict, has, parseCommandLine, parseFailure } from "./clap.js";
import { type Algorithm, digestInput, openInput, type Verbosity } from "./digest.js";

const FAILED = 1;

const SPEC: CommandSpec = {
  usage: null,
  options: [
    { name: "binary", short: ["b"], repeatable: true },
    { name: "check", short: ["c"], repeatable: true },
    { name: "tag", repeatable: true },
    { name: "text", short: ["t"], repeatable: true },
    { name: "quiet", short: ["q"], repeatable: true },
    { name: "status", short: ["s"], repeatable: true },
    { name: "strict", repeatable: true },
    { name: "ignore-missing", repeatable: true },
    { name: "warn", short: ["w"], repeatable: true },
    { name: "zero", short: ["z"], repeatable: true },
    { name: "help", short: ["h"], refused: true },
    { name: "version", short: ["V"], refused: true },
  ],
};

export function checksumCommand(name: string, algorithm: Algorithm): Command {
  // uutils prints a placeholder where the usage line belongs.
  const spec: CommandSpec = { ...SPEC, usage: `${name}-usage` };
  return (context) => {
    let parsed: ReturnType<typeof parseCommandLine>;
    try {
      parsed = parseCommandLine(context.argv, spec);
      const exclusive = parsed.occurrences.filter(
        (occurrence) => occurrence.name === "check" || occurrence.name === "tag",
      );
      const first = exclusive[0];
      const other = exclusive.find((occurrence) => occurrence.name !== first?.name);
      if (first !== undefined && other !== undefined) {
        throw conflict(`--${first.name}`, `--${other.name}`);
      }
    } catch (error) {
      const failed = parseFailure(context, error, FAILED);
      if (failed !== null) return failed;
      throw error;
    }

    let verbosity: Verbosity = "normal";
    for (const occurrence of parsed.occurrences) {
      if (
        occurrence.name === "quiet" ||
        occurrence.name === "status" ||
        occurrence.name === "warn"
      ) {
        verbosity = occurrence.name;
      }
    }
    const operands = parsed.operands.length === 0 ? ["-"] : parsed.operands;

    if (has(parsed, "check")) {
      if (has(parsed, "binary") || has(parsed, "text")) {
        return fail(
          context,
          "the --binary and --text options are meaningless when verifying checksums",
        );
      }
      const options = {
        verbosity,
        strict: has(parsed, "strict"),
        ignoreMissing: has(parsed, "ignore-missing"),
      };
      return deferred((setStatus) => verify(context, algorithm, operands, options, setStatus));
    }
    if (verbosity === "quiet" || verbosity === "status") {
      return fail(context, "the --quiet option is meaningful only when verifying checksums");
    }
    for (const option of ["strict", "ignore-missing"]) {
      if (has(parsed, option)) {
        return fail(context, `the --${option} option is meaningful only when verifying checksums`);
      }
    }

    const style = {
      tag: has(parsed, "tag"),
      binary: lastOf(parsed.occurrences, "binary", "text") === "binary",
      zero: has(parsed, "zero"),
    };
    return deferred((setStatus) => compute(context, algorithm, operands, style, setStatus));
  };
}

interface Style {
  readonly tag: boolean;
  readonly binary: boolean;
  readonly zero: boolean;
}

async function* compute(
  context: CommandContext,
  algorithm: Algorithm,
  operands: readonly string[],
  style: Style,
  setStatus: (status: number) => void,
): ByteStream {
  for (const operand of operands) {
    const opened = openInput(context, operand);
    if (opened.kind === "missing") {
      context.warn(`${operand}: No such file or directory (os error 2)`);
      setStatus(FAILED);
      continue;
    }
    if (opened.kind === "directory") {
      context.warn("failed to read input: Is a directory");
      setStatus(FAILED);
      return;
    }
    const hash = await digestInput(context, algorithm, opened);
    yield encode(outputLine(algorithm, operand, hash, style));
  }
}

function outputLine(algorithm: Algorithm, name: string, hash: string, style: Style): string {
  const terminator = style.zero ? "\0" : "\n";
  // A name with a backslash or newline is escaped and the line marked with a
  // leading backslash, so a check can read it back. NUL-terminated output
  // needs no escaping.
  const escaped = !style.zero && /[\\\n]/.test(name);
  const shown = escaped ? name.replaceAll("\\", "\\\\").replaceAll("\n", "\\n") : name;
  const prefix = escaped ? "\\" : "";
  if (style.tag) return `${prefix}${algorithm.tag} (${shown}) = ${hash}${terminator}`;
  return `${prefix}${hash} ${style.binary ? "*" : " "}${shown}${terminator}`;
}

function lastOf(
  occurrences: ReturnType<typeof parseCommandLine>["occurrences"],
  ...names: readonly string[]
): string | null {
  let found: string | null = null;
  for (const occurrence of occurrences) {
    if (names.includes(occurrence.name)) found = occurrence.name;
  }
  return found;
}
