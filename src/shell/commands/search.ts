// The search engine. `grep` and `rg` are two flag surfaces over this one
// implementation — see docs/plans/shell.md §5.1.
//
// The cost model is the whole point, and there are two of them.
//
// When the pattern is a plain substring — which is most of what agents
// search for — the match itself is a SQL predicate: `discoverFilesContaining`
// answers "which files contain these bytes" without the other files' content
// ever reaching the isolate. Over 6,000 files that measured 1 statement
// against 24, and on a Durable Object the heap it does not touch matters
// more than the statement it does not run.
//
// When the pattern is a real expression, SQLite has no regex to push down to,
// so it falls back to `discoverFiles` (one indexed statement per page) feeding
// `readFileHandles` (one statement per byte budget). Either way the generator
// is pulled lazily, so a consumer that stops — `| head -20` — stops it here.

import type { RealPath, RegularFileHandle } from "../../fs/types.js";
import { type ByteStream, decode, encode, lines, looksBinary, NEWLINE } from "../exec/bytes.js";
import type { BoundedFs } from "../exec/context.js";
import { compileIncludeGlob } from "../exec/glob.js";

export interface SearchRequest {
  readonly pattern: RegExp;
  /** Absolute paths. A file is searched directly; a directory is walked. */
  readonly roots: readonly string[];
  readonly recursive: boolean;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  /** Skip dotfiles and dot-directories. rg's default, grep's never. */
  readonly skipHidden: boolean;
  readonly invert: boolean;
  readonly mode: "content" | "files" | "count";
  readonly lineNumbers: boolean;
  /** null lets the engine decide: on when more than one file is searched. */
  readonly withFilename: boolean | null;
  readonly before: number;
  readonly after: number;
  /**
   * The pattern as plain bytes, when it is a substring rather than an
   * expression. Null disables the SQL predicate — as `-i` and `-v` must,
   * since `instr` is case-sensitive and cannot answer an inverted search.
   */
  readonly literal: Uint8Array | null;
}

export interface SearchOutcome {
  readonly stream: ByteStream;
  /** Valid once the stream is drained. 0 when something matched. */
  status(): number;
}

const PAGE_MAX = 1_000;

export function search(fs: BoundedFs, request: SearchRequest): SearchOutcome {
  // Tracked separately from output: `-c` prints `0` for a file with no
  // matches, so "something was written" is not "something matched".
  let matched = false;
  let failed = false;
  const noteMatch = (): void => {
    matched = true;
  };

  const stream = (function* (): ByteStream {
    const includeMatchers = request.include.map(compileIncludeGlob);
    const excludeMatchers = request.exclude.map(compileIncludeGlob);
    // Whether a name is printed follows what is *searched*, not what was
    // asked for: one explicit file gets no prefix even from rg, which is
    // recursive by default and would otherwise label every single-file run.
    const several = request.roots.length > 1;

    for (const root of request.roots) {
      const stat = fs.stat(root);
      if (stat === null) {
        failed = true;
        continue;
      }

      if (stat.type !== "dir") {
        const bytes = fs.readFile(root);
        yield* emit(root, bytes, request, request.withFilename ?? several, noteMatch);
        continue;
      }

      if (!request.recursive) {
        failed = true;
        continue;
      }

      // A walked directory always labels: the reader cannot tell otherwise.
      // `-l` over a literal pattern needs no content at all: the database
      // already decided, and reading the file would only confirm it.
      const needsBytes = request.mode !== "files" || request.literal === null;
      for (const file of walk(fs, root, request, includeMatchers, excludeMatchers, needsBytes)) {
        if (file.bytes === null) {
          noteMatch();
          yield encode(`${file.path}\n`);
          continue;
        }
        yield* emit(file.path, file.bytes, request, request.withFilename ?? true, noteMatch);
      }
    }
  })();

  return { stream, status: () => (matched ? 0 : failed ? 2 : 1) };
}

interface FoundFile {
  readonly path: string;
  /**
   * Null when the database proved the file contains the needle and the
   * caller said it did not need the content — `grep -l` over a literal
   * pattern never reads a byte of the files it names.
   */
  readonly bytes: Uint8Array | null;
}

/**
 * Every candidate file under `root`, read in batches.
 *
 * The SQL GLOB narrows and JS decides. SQLite's `*` crosses `/`, which for a
 * recursive search is exactly the wanted semantic, so `<root>/*<tail>` is
 * both a legal narrowing and usually the exact set. Over the platform's
 * 50-byte pattern ceiling the narrowing degrades to `*` — a superset, still
 * bounded by the subtree range — and JS filters as before.
 */
function* walk(
  fs: BoundedFs,
  root: string,
  request: SearchRequest,
  include: ReadonlyArray<{ test(path: string): boolean }>,
  exclude: ReadonlyArray<{ test(path: string): boolean }>,
  needsBytes: boolean,
): Generator<FoundFile, void, undefined> {
  const realRoot = fs.realpath(root);
  const sqlPattern = narrowing(realRoot, request.include);

  // `-c` prints a count for every file searched, zeros included, so it needs
  // the files the predicate would filter out. Found by the equivalence test
  // in tests/shell/pushdown.test.ts, which is what that suite is for.
  if (request.literal !== null && request.mode !== "count") {
    yield* walkByContent(fs, realRoot, sqlPattern, request, include, exclude, needsBytes);
    return;
  }
  // Always a full page.
  //
  // An earlier revision seeded the first page at `2 * limitHint`, on the
  // strength of a Wave A probe whose fixture matched every other file. That
  // was the wrong lesson: discovery costs ONE statement whatever the page
  // size, so a small page only buys more round trips, and at a realistic
  // match density (one file in ten) `grep … | head -20` measured *more*
  // expensive than the unbounded search it was supposed to beat. The
  // bounding comes from the consumer refusing to pull, further down.
  const limit = PAGE_MAX;
  let after: RealPath | undefined;

  for (;;) {
    const page = fs.discoverFiles(
      realRoot,
      sqlPattern,
      after === undefined ? { limit } : { after, limit },
    );
    if (page.handles.length === 0) return;

    const wanted: RegularFileHandle[] = [];
    for (const handle of page.handles) {
      if (accepted(handle.path, realRoot, request, include, exclude)) wanted.push(handle);
    }

    yield* read(fs, wanted);

    if (page.next === null) return;
    after = page.next;
  }
}

/**
 * The pushed-down path: the database decides which files contain the needle.
 *
 * `matched` handles are proven and need no read unless the caller wants the
 * lines. `undecided` handles span more than one chunk, where a needle can
 * straddle a boundary and `instr` cannot rule them out — those are always
 * read and checked, so the answer matches what a full pass would give.
 */
function* walkByContent(
  fs: BoundedFs,
  realRoot: RealPath,
  sqlPattern: string,
  request: SearchRequest,
  include: ReadonlyArray<{ test(path: string): boolean }>,
  exclude: ReadonlyArray<{ test(path: string): boolean }>,
  needsBytes: boolean,
): Generator<FoundFile, void, undefined> {
  const needle = request.literal;
  if (needle === null) return;
  let after: RealPath | undefined;

  for (;;) {
    const page = fs.discoverFilesContaining(
      realRoot,
      sqlPattern,
      needle,
      after === undefined ? { limit: PAGE_MAX } : { after, limit: PAGE_MAX },
    );

    const keep = (handle: RegularFileHandle): boolean =>
      accepted(handle.path, realRoot, request, include, exclude);
    const proven = page.matched.filter(keep);
    const unread = page.undecided.filter(keep);

    if (!needsBytes) {
      for (const handle of proven) yield { path: handle.path, bytes: null };
    }

    // A proven file still needs its bytes when the caller wants lines; an
    // undecided one always does.
    const toRead = needsBytes ? [...proven, ...unread] : unread;
    for (const file of read(fs, toRead)) yield file;

    if (page.next === null) return;
    after = page.next;
  }
}

/** Read a set of handles in budget-sized batches. */
function* read(
  fs: BoundedFs,
  handles: readonly RegularFileHandle[],
): Generator<FoundFile, void, undefined> {
  let pending: readonly RegularFileHandle[] = handles;
  while (pending.length > 0) {
    const batch = fs.readFileHandles(pending, { budget: fs.readBudget });
    for (const handle of pending) {
      const bytes = batch.files.get(handle.path);
      if (bytes !== undefined) yield { path: handle.path, bytes };
    }
    pending = batch.remaining;
  }
}

/** A SQL GLOB that is always a superset of what the request wants. */
function narrowing(root: RealPath, include: readonly string[]): string {
  const only = include.length === 1 ? include[0] : undefined;
  if (only === undefined) return "*";
  // The longest trailing run with no metacharacter — `*.ts` gives `.ts`.
  const tail = /[^*?[\]]*$/.exec(only)?.[0] ?? "";
  if (tail === "") return "*";
  const candidate = `${root === "/" ? "" : root}/*${tail}`;
  return new TextEncoder().encode(candidate).length > 50 ? "*" : candidate;
}

function accepted(
  path: string,
  root: RealPath,
  request: SearchRequest,
  include: ReadonlyArray<{ test(path: string): boolean }>,
  exclude: ReadonlyArray<{ test(path: string): boolean }>,
): boolean {
  if (request.skipHidden) {
    const relative = path.slice(root === "/" ? 1 : root.length + 1);
    if (relative.split("/").some((segment) => segment.startsWith("."))) return false;
  }
  if (exclude.some((matcher) => matcher.test(path))) return false;
  if (include.length > 0 && !include.some((matcher) => matcher.test(path))) return false;
  return true;
}

/** One file's contribution to the output. */
function* emit(
  path: string,
  bytes: Uint8Array,
  request: SearchRequest,
  withFilename: boolean,
  noteMatch: () => void,
): Generator<Uint8Array, void, undefined> {
  if (looksBinary(bytes)) {
    // Match GNU grep: report, never dump bytes into an agent's context.
    if (!matchesAnywhere(bytes, request)) return;
    noteMatch();
    if (request.mode !== "count") yield encode(`Binary file ${path} matches\n`);
    return;
  }

  if (request.mode === "files") {
    if (!matchesAnywhere(bytes, request)) return;
    noteMatch();
    yield encode(`${path}\n`);
    return;
  }

  const all = [...lines(chunk(bytes))];
  const hits: number[] = [];
  for (let index = 0; index < all.length; index++) {
    const text = all[index];
    if (text !== undefined && test(text, request)) hits.push(index);
  }

  if (hits.length > 0) noteMatch();

  if (request.mode === "count") {
    yield encode(withFilename ? `${path}:${hits.length}\n` : `${hits.length}\n`);
    return;
  }

  const emitted = new Set<number>();
  let previous = -1;
  for (const index of hits) {
    const from = Math.max(0, index - request.before);
    const to = Math.min(all.length - 1, index + request.after);
    if (previous >= 0 && from > previous + 1 && (request.before > 0 || request.after > 0)) {
      yield encode("--\n");
    }
    for (let at = from; at <= to; at++) {
      if (emitted.has(at)) continue;
      emitted.add(at);
      const text = all[at];
      if (text === undefined) continue;
      yield render(path, at + 1, text, at === index, request, withFilename);
      previous = at;
    }
  }
}

function render(
  path: string,
  number: number,
  text: Uint8Array,
  isMatch: boolean,
  request: SearchRequest,
  withFilename: boolean,
): Uint8Array {
  // Context lines use `-` where matches use `:`, as both greps do.
  const separator = isMatch ? ":" : "-";
  let prefix = "";
  if (withFilename) prefix += `${path}${separator}`;
  if (request.lineNumbers) prefix += `${number}${separator}`;
  const head = encode(prefix);
  const out = new Uint8Array(head.length + text.length + 1);
  out.set(head, 0);
  out.set(text, head.length);
  out[head.length + text.length] = NEWLINE;
  return out;
}

function matchesAnywhere(bytes: Uint8Array, request: SearchRequest): boolean {
  for (const text of lines(chunk(bytes))) {
    if (test(text, request)) return true;
  }
  return false;
}

function test(text: Uint8Array, request: SearchRequest): boolean {
  request.pattern.lastIndex = 0;
  const hit = request.pattern.test(decode(text));
  return request.invert ? !hit : hit;
}

function* chunk(bytes: Uint8Array): ByteStream {
  yield bytes;
}
