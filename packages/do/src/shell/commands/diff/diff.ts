// `diff` between two files, or a file and stdin, in GNU's normal or unified
// format. Both inputs are read whole and held against the retained budget
// while the edit script is computed, in linear space. Exit status is 0 when
// equal, 1 when different, and 2 on trouble. Directory comparison is refused.

import { basename } from "../../../fs/path.js";
import { concat, empty, encode, equals, firstNul, NEWLINE, one } from "../../exec/bytes.js";
import {
  type Command,
  type CommandContext,
  type CommandResult,
  result,
} from "../../exec/context.js";
import { resolve } from "../../exec/execute.js";
import { parseFlags, UsageError } from "../flags.js";
import { groups, type Line, normal, unified } from "./format.js";
import { editScript } from "./myers.js";

/** Options GNU diff has and this one does not: whitespace, recursion, other formats. */
const REFUSED: ReadonlySet<string> = new Set([
  "-r",
  "-N",
  "-w",
  "-b",
  "-B",
  "-i",
  "-c",
  "-y",
  "-e",
  "-a",
]);

interface Input {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mtime: number;
}

export const diff: Command = async (context) => {
  const parsed = parseFlags(context.argv, {
    boolean: new Set(["-u", "-q", "--brief", "-s", "--report-identical-files", ...REFUSED]),
    valued: new Set(["-U", "--unified"]),
  });
  const refused = parsed.flags.find((flag) => REFUSED.has(flag.name));
  if (refused !== undefined) {
    throw new UsageError(`${refused.name} is not supported; supported: -u, -U N, -q, -s`);
  }
  let contextLines: number | null = null;
  let brief = false;
  let reportIdentical = false;
  for (const flag of parsed.flags) {
    switch (flag.name) {
      case "-u":
        contextLines = 3;
        break;
      case "-U":
      case "--unified": {
        const value = flag.value ?? "";
        if (!/^[0-9]+$/.test(value)) {
          return usageTrouble(context, `invalid context length '${value}'`);
        }
        contextLines = Number(value);
        break;
      }
      case "-q":
      case "--brief":
        brief = true;
        break;
      default:
        reportIdentical = true;
    }
  }
  const [left, right, extra] = parsed.operands;
  if (left === undefined) return usageTrouble(context, "missing operand after 'diff'");
  if (right === undefined) return usageTrouble(context, `missing operand after '${left}'`);
  if (extra !== undefined) return usageTrouble(context, `extra operand '${extra}'`);

  const releases: Array<() => void> = [];
  try {
    const a = await load(context, left, right, releases);
    if (typeof a === "string") return trouble(context, a);
    const b = await load(context, right, left, releases);
    if (typeof b === "string") return trouble(context, b);

    if (equals(a.bytes, b.bytes)) {
      if (!reportIdentical) return result(empty(), 0);
      return result(one(encode(`Files ${a.name} and ${b.name} are identical\n`)), 0);
    }
    if (brief) return result(one(encode(`Files ${a.name} and ${b.name} differ\n`)), 1);
    if (firstNul(a.bytes) >= 0 || firstNul(b.bytes) >= 0) {
      return result(one(encode(`Binary files ${a.name} and ${b.name} differ\n`)), 1);
    }

    const aLines = split(a.bytes);
    const bLines = split(b.bytes);
    const ids = new Map<string, number>();
    const script = editScript(intern(aLines, ids), intern(bLines, ids));
    const changes = groups(script);
    const body =
      contextLines === null
        ? [...normal(changes, aLines, bLines)]
        : [
            encode(`--- ${a.name}\t${timestamp(a.mtime)}\n`),
            encode(`+++ ${b.name}\t${timestamp(b.mtime)}\n`),
            ...unified(changes, aLines, bLines, contextLines),
          ];
    return result(one(concat(body)), 1);
  } catch (error) {
    if (error instanceof UsageError) return trouble(context, error.message);
    throw error;
  } finally {
    for (const release of releases) release();
  }
};

/**
 * An operand's bytes, or the diagnostic for why there are none. A directory
 * against a file compares the file of the same name inside it, as GNU does.
 */
async function load(
  context: CommandContext,
  operand: string,
  other: string,
  releases: Array<() => void>,
): Promise<Input | string> {
  if (operand === "-") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of context.stdin ?? empty()) {
      releases.push(context.fs.retained.retain(chunk.length, "diff input"));
      chunks.push(chunk.slice());
    }
    return { name: "-", bytes: concat(chunks), mtime: Date.now() };
  }
  let name = operand;
  let path = resolve(context.cwd, operand);
  let stat = context.fs.stat(path);
  if (stat?.type === "dir") {
    if (other === "-" || context.fs.stat(resolve(context.cwd, other))?.type === "dir") {
      throw new UsageError("comparing directories is not supported");
    }
    name = `${operand.replace(/\/+$/, "")}/${basename(resolve(context.cwd, other))}`;
    path = resolve(context.cwd, name);
    stat = context.fs.stat(path);
  }
  if (stat === null) return `${name}: No such file or directory`;
  releases.push(context.fs.retained.retain(stat.size, "diff input"));
  return { name, bytes: context.fs.readFile(path), mtime: stat.mtime };
}

function split(bytes: Uint8Array): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== NEWLINE) continue;
    lines.push({ text: bytes.subarray(start, index), terminated: true });
    start = index + 1;
  }
  if (start < bytes.length) lines.push({ text: bytes.subarray(start), terminated: false });
  return lines;
}

/** Equal lines share an id. A final line without a newline differs from one with it. */
function intern(lines: readonly Line[], ids: Map<string, number>): Int32Array {
  const out = new Int32Array(lines.length);
  for (const [index, line] of lines.entries()) {
    let key = line.terminated ? "\n" : "";
    for (const byte of line.text) key += String.fromCharCode(byte);
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    out[index] = id;
  }
  return out;
}

/** GNU's `%Y-%m-%d %H:%M:%S.%N %z`, in UTC. */
function timestamp(milliseconds: number): string {
  const iso = new Date(milliseconds).toISOString();
  const nanoseconds = `${iso.slice(20, 23)}000000`;
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${nanoseconds} +0000`;
}

function usageTrouble(context: CommandContext, message: string): CommandResult {
  context.warn(message);
  context.warn("Try 'diff --help' for more information.");
  return result(empty(), 2);
}

function trouble(context: CommandContext, message: string): CommandResult {
  context.warn(message);
  return result(empty(), 2);
}
