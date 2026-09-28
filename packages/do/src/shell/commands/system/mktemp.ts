// `mktemp` in uutils' shape: the last run of three or more X's in the template
// is replaced with characters from crypto.getRandomValues, and the file (0600)
// or directory (0700) is created without creating its parent. Nothing
// auto-creates /tmp; a missing parent fails as it does on a host.

import { empty, encode, line, one } from "../../exec/bytes.js";
import { type Command, type CommandContext, fail, result } from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";
import { type CommandSpec, has, last, parseCommandLine, parseFailure } from "./clap.js";

const FAILED = 1;
const DEFAULT_TEMPLATE = "tmp.XXXXXXXXXX";
const DEFAULT_DIRECTORY = "/tmp";
const NAME_CHARACTERS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// The largest multiple of the alphabet below 256, so a random byte maps to a
// character without modulo bias.
const UNBIASED_LIMIT = 256 - (256 % NAME_CHARACTERS.length);
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

const SPEC: CommandSpec = {
  usage: "mktemp [OPTION]... [TEMPLATE]",
  usageOnRepeat: true,
  options: [
    { name: "directory", short: ["d"] },
    { name: "dry-run", short: ["u"] },
    { name: "quiet", short: ["q"] },
    { name: "suffix", value: "required", valueName: "SUFFIX" },
    { name: "p", short: ["p"], value: "required", display: "-p <DIR>" },
    { name: "tmpdir", value: "equals", valueName: "DIR" },
    { name: "t", short: ["t"], display: "-t" },
    { name: "help", short: ["h"], refused: true },
    { name: "version", short: ["V"], refused: true },
  ],
};

export const mktemp: Command = (context) => {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(context.argv, SPEC);
  } catch (error) {
    const failed = parseFailure(context, error, FAILED);
    if (failed !== null) return failed;
    throw error;
  }
  if (parsed.operands.length > 1) {
    context.warn("too many templates");
    context.diagnostic(encode("Try 'mktemp --help' for more information.\n"));
    return result(empty(), FAILED);
  }

  const directory = has(parsed, "directory");
  const operand = parsed.operands[0];
  const template = operand ?? DEFAULT_TEMPLATE;
  const suffixOption = last(parsed, "suffix");
  const suffix = suffixOption ?? null;

  if (suffix?.includes("/")) {
    return fail(context, `invalid suffix '${suffix}', contains directory separator`);
  }
  if (suffix !== null && !template.endsWith("X")) {
    return fail(context, `with --suffix, template '${template}' must end in X`);
  }
  // The last run of X's is the one replaced, wherever it sits.
  const end = template.lastIndexOf("X") + 1;
  let start = end;
  while (start > 0 && template.charAt(start - 1) === "X") start--;
  if (end - start < 3) return fail(context, `too few X's in template '${template}'`);
  const prefix = template.slice(0, start);
  const placeholder = template.slice(start, end);
  const implicitSuffix = template.slice(end);
  if (implicitSuffix.includes("/")) {
    return fail(context, `invalid suffix '${implicitSuffix}', contains directory separator`);
  }

  const parent = parentDirectory(context, parsed, operand === undefined);
  if (parent !== null && template.startsWith("/")) {
    return fail(context, `invalid template, '${template}'; with --tmpdir, it may not be absolute`);
  }
  if (has(parsed, "t") && template.includes("/")) {
    return fail(context, `invalid template, '${template}', contains directory separator`);
  }

  const fullSuffix = `${implicitSuffix}${suffix ?? ""}`;
  const display = join(parent, `${prefix}${placeholder}${fullSuffix}`);
  for (;;) {
    const name = join(parent, `${prefix}${randomName(placeholder.length)}${fullSuffix}`);
    const path = resolve(context.cwd, name);
    if (context.fs.stat(path) !== null) continue;
    if (!has(parsed, "dry-run")) {
      const failure = create(context, path, directory);
      if (failure !== null) {
        if (has(parsed, "quiet")) return result(empty(), FAILED);
        const kind = directory ? "directory" : "file";
        return fail(context, `failed to create ${kind} via template '${display}': ${failure}`);
      }
    }
    return result(one(line(name)));
  }
};

/** Where the template lives, or null when it is taken as written. */
function parentDirectory(
  context: CommandContext,
  parsed: ReturnType<typeof parseCommandLine>,
  implicitTemplate: boolean,
): string | null {
  const environment = context.env?.TMPDIR;
  const fallback = environment ?? DEFAULT_DIRECTORY;
  // `-t` prefers TMPDIR even over `-p`, as uutils does.
  if (has(parsed, "t") && environment !== undefined) return environment;
  const explicit = last(parsed, "p");
  if (explicit !== undefined) return explicit === "" || explicit === null ? fallback : explicit;
  const tmpdir = last(parsed, "tmpdir");
  if (tmpdir !== undefined) return tmpdir === null || tmpdir === "" ? fallback : tmpdir;
  if (has(parsed, "t") || implicitTemplate) return fallback;
  return null;
}

function join(parent: string | null, name: string): string {
  if (parent === null || parent === "") return name;
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

function randomName(length: number): string {
  let name = "";
  const bytes = new Uint8Array(length * 2);
  while (name.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= UNBIASED_LIMIT || name.length === length) continue;
      name += NAME_CHARACTERS.charAt(byte % NAME_CHARACTERS.length);
    }
  }
  return name;
}

/** Create the entry without its parent; the C-library message on failure. */
function create(context: CommandContext, path: string, directory: boolean): string | null {
  const entry = directory
    ? { path, mode: DIRECTORY_MODE }
    : { path, bytes: new Uint8Array(0), mode: FILE_MODE };
  try {
    context.fs.writeFiles([entry], { parents: false });
    return null;
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ENOENT") return "No such file or directory";
      if (error.code === "ENOTDIR") return "Not a directory";
    }
    throw error;
  }
}
