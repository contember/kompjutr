// `tree`, as tree 2.2.1 prints it under the C locale.
//
// A line's connector depends on whether the entry is its directory's last
// shown sibling, and that sibling follows the entry's whole subtree in path
// order. So the walk lists one directory at a time through keyset pages and
// holds, per open level, only the page being consumed plus one look-ahead
// entry — never a whole directory or subtree. A consumer that stops pulling
// stops the listing.

import { basename, dirname } from "../../../fs/path.js";
import type { ListCursor, ScanEntry, Stat } from "../../../fs/types.js";
import { type ByteStream, encode } from "../../exec/bytes.js";
import { type Command, type CommandContext, fail } from "../../exec/context.js";
import { displayUnder } from "../../exec/display.js";
import { resolve } from "../../exec/execute.js";
import { matchesPattern, printable } from "./pattern.js";
import {
  type Charset,
  parseTreeOptions,
  type TreeOptions,
  TreeUsageError,
} from "./tree-options.js";

const PAGE_MAX = 1_000;
const ENTRY_OVERHEAD_BYTES = 64;

interface Lines {
  readonly branch: string;
  readonly last: string;
  readonly through: string;
  readonly blank: string;
}

const LINES: Record<Charset, Lines> = {
  ascii: { branch: "|-- ", last: "`-- ", through: "|   ", blank: "    " },
  utf8: {
    branch: "├── ",
    last: "└── ",
    through: "│   ",
    blank: "    ",
  },
};

interface Child {
  readonly entry: ScanEntry;
  /** What the symlink resolves to; null for other entries and dangling links. */
  readonly target: Stat | null;
  readonly isDirectory: boolean;
}

interface Level {
  readonly siblings: Lookahead;
  readonly display: string;
  readonly prefix: string;
  readonly depth: number;
}

interface Counts {
  directories: number;
  files: number;
}

export const tree: Command = (context) => {
  let options: TreeOptions;
  try {
    options = parseTreeOptions(context.argv);
  } catch (error) {
    if (error instanceof TreeUsageError) return fail(context, error.message, 1);
    throw error;
  }

  let status = 0;
  const stream = (function* (): ByteStream {
    const counts: Counts = { directories: 0, files: 0 };
    for (const operand of options.operands) {
      const path = resolve(context.cwd, operand);
      const stat = context.fs.statTarget(path);
      if (stat === null || stat.type !== "dir") {
        yield encode(`${printable(operand)}  [error opening dir]\n`);
        if (stat === null) status = 2;
        else counts.files++;
        continue;
      }
      counts.directories++;
      const top = options.fullPath ? withoutTrailingSlashes(operand) : operand;
      yield encode(`${printable(top)}${options.classify ? "/" : ""}\n`);
      yield* walk(context, options, top, path, counts);
    }
    if (!options.noReport) yield encode(report(options, counts));
  })();
  return { stdout: stream, status: () => status, truncated: () => false };
};

function* walk(
  context: CommandContext,
  options: TreeOptions,
  rootDisplay: string,
  root: string,
  counts: Counts,
): ByteStream {
  const lines = LINES[options.charset];
  const levels: Level[] = [
    {
      siblings: new Lookahead(children(context, options, root)),
      display: rootDisplay,
      prefix: "",
      depth: 1,
    },
  ];
  try {
    for (let level = levels.at(-1); level !== undefined; level = levels.at(-1)) {
      const next = level.siblings.take();
      if (next === null) {
        levels.pop()?.siblings.close();
        continue;
      }
      const { child, last } = next;
      const display = displayUnder(level.display, dirname(child.entry.path), child.entry.path);
      if (child.isDirectory) counts.directories++;
      else counts.files++;
      const connector = options.noIndent
        ? ""
        : `${level.prefix}${last ? lines.last : lines.branch}`;
      yield encode(`${connector}${label(options, child, display)}\n`);

      const descend =
        child.entry.type === "dir" && (options.level === null || level.depth < options.level);
      if (!descend) continue;
      levels.push({
        siblings: new Lookahead(children(context, options, child.entry.path)),
        display,
        prefix: `${level.prefix}${last ? lines.blank : lines.through}`,
        depth: level.depth + 1,
      });
    }
  } finally {
    for (const level of levels) level.siblings.close();
  }
}

/** The shown children of one directory, in name byte order, a keyset page at a time. */
function* children(
  context: CommandContext,
  options: TreeOptions,
  directory: string,
): Generator<Child, void, undefined> {
  const phases: ReadonlyArray<boolean | null> = options.directoriesFirst ? [true, false] : [null];
  const limit = Math.min(PAGE_MAX, Math.max(1, (context.limitHint ?? 500) * 2));
  for (const wantDirectories of phases) {
    let after: ListCursor | undefined;
    for (;;) {
      const page = context.fs.listEntries(
        directory,
        after === undefined ? { limit } : { after, limit },
      );
      const release = context.fs.retained.retain(pageBytes(page.items), "tree listing page");
      try {
        for (const item of page.items) {
          const child = shown(context, options, item.entry);
          if (child === null) continue;
          if (wantDirectories !== null && child.isDirectory !== wantDirectories) continue;
          yield child;
        }
      } finally {
        release();
      }
      if (page.next === null) break;
      after = page.next;
    }
  }
}

function shown(
  context: CommandContext,
  options: TreeOptions,
  entry: ScanEntry | null,
): Child | null {
  if (entry === null) return null;
  const name = basename(entry.path);
  if (!options.all && name.startsWith(".")) return null;
  const target = entry.type === "symlink" ? context.fs.statTarget(entry.path) : null;
  const isDirectory = entry.type === "dir" || target?.type === "dir";
  if (options.directoriesOnly && !isDirectory) return null;
  if (options.exclude.some((pattern) => matchesPattern(name, pattern, isDirectory))) return null;
  if (
    !isDirectory &&
    options.include.length > 0 &&
    !options.include.some((pattern) => matchesPattern(name, pattern, false))
  ) {
    return null;
  }
  return { entry, target, isDirectory };
}

function label(options: TreeOptions, child: Child, display: string): string {
  const name = printable(options.fullPath ? display : basename(child.entry.path));
  const { entry } = child;
  if (entry.type === "symlink") {
    const suffix = options.classify && child.target !== null ? classification(child.target) : "";
    return `${name} -> ${printable(entry.target ?? "")}${suffix}`;
  }
  return options.classify ? `${name}${classification(entry)}` : name;
}

function classification(stat: Stat): string {
  if (stat.type === "dir") return "/";
  return (stat.mode & 0o111) !== 0 ? "*" : "";
}

function report(options: TreeOptions, counts: Counts): string {
  const directories = `${counts.directories} director${counts.directories === 1 ? "y" : "ies"}`;
  if (options.directoriesOnly) return `\n${directories}\n`;
  return `\n${directories}, ${counts.files} file${counts.files === 1 ? "" : "s"}\n`;
}

/** `-f` prints the root without trailing slashes and joins every path below it with one. */
function withoutTrailingSlashes(operand: string): string {
  return operand.replace(/(?<=.)\/+$/, "");
}

function pageBytes(items: ReadonlyArray<{ readonly entry: ScanEntry | null }>): number {
  let bytes = 0;
  for (const item of items) {
    bytes +=
      ENTRY_OVERHEAD_BYTES +
      2 * ((item.entry?.path.length ?? 0) + (item.entry?.target?.length ?? 0));
  }
  return bytes;
}

/** One sibling of look-ahead: an entry is known to be last before it prints. */
class Lookahead {
  #pending: IteratorResult<Child, void> | null = null;

  constructor(private readonly source: Generator<Child, void, undefined>) {}

  take(): { child: Child; last: boolean } | null {
    const current = this.#pending ?? this.source.next();
    if (current.done === true) return null;
    this.#pending = this.source.next();
    return { child: current.value, last: this.#pending.done === true };
  }

  close(): void {
    this.source.return();
  }
}
