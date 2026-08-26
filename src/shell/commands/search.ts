// The search engine. `grep` and `rg` are two flag surfaces over this one
// implementation — see docs/archive/plans/shell.md §5.1.
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
import { type ByteStream, decode, encode, firstNul, lines, NEWLINE } from "../exec/bytes.js";
import type { BoundedFs } from "../exec/context.js";
import { compileIncludeGlob, GLOB_PATTERN_MAX_BYTES } from "../exec/glob.js";

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
  readonly mode: SearchMode;
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
  /**
   * Whether `-c` names files with no matches. GNU grep prints `path:0` for
   * every file it searched; rg lists only files that matched. The flag is
   * spelled the same and the output is not, which is why the engine is told
   * rather than left to guess.
   */
  readonly zeroCounts: boolean;
  /** A diagnostic for the surface's stderr — an unreadable path, so far. */
  warn(message: string): void;
  /**
   * Report a matching binary file, returning the stdout line if the surface
   * writes one. The two greps disagree about both text and stream: GNU
   * sends `grep: <path>: binary file matches` to stderr, rg writes its own
   * form to stdout. Neither ever lets the bytes themselves through, which
   * is the part that matters for an agent reading the pipe.
   */
  reportBinary(path: string, offset: number, withFilename: boolean): Uint8Array | null;
  /**
   * What to do with a binary file a *walk* turned up. rg drops it silently;
   * grep reports it. A file named on the command line is always searched by
   * both, so this only governs the walked ones.
   */
  readonly walkedBinaries: "report" | "skip";
}

export type SearchMode = "content" | "files" | "files-without-match" | "count";

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
        request.warn(`${root}: No such file or directory`);
        continue;
      }

      if (stat.type !== "dir") {
        if (stat.size > fs.retained.available) {
          fs.retained.retain(stat.size, "named search file");
        }
        const release = fs.retained.retain(stat.size, "named search file");
        try {
          const bytes = fs.readFile(root);
          // Named on the command line: searched whatever it holds.
          yield* emit(root, bytes, request, request.withFilename ?? several, noteMatch, "report");
        } finally {
          release();
        }
        continue;
      }

      if (!request.recursive) {
        failed = true;
        request.warn(`${root}: Is a directory`);
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
        yield* emit(
          file.path,
          file.bytes,
          request,
          request.withFilename ?? true,
          noteMatch,
          request.walkedBinaries,
        );
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

  // The predicate returns the files that match, so a mode whose output
  // depends on the files that do *not* cannot use it: GNU's `-c` prints
  // `path:0` for every file searched, and `-L` is the complement outright.
  // rg's `-c` lists only matches, so it keeps the fast path. The first of
  // those was found by the equivalence test in tests/shell/pushdown.test.ts,
  // which is what that suite is for.
  const complementary =
    request.mode === "files-without-match" || (request.mode === "count" && request.zeroCounts);
  if (request.literal !== null && !complementary) {
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

  // rg skips a binary file a walk turned up. Asking the database to drop
  // them keeps that free: finding out in the isolate would mean reading
  // every candidate, which is the cost the predicate exists to avoid.
  const excludeBinary = request.walkedBinaries === "skip";

  for (;;) {
    const page = fs.discoverFilesContaining(
      realRoot,
      sqlPattern,
      needle,
      after === undefined
        ? { limit: PAGE_MAX, excludeBinary }
        : { after, limit: PAGE_MAX, excludeBinary },
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
    const first = pending[0];
    if (first !== undefined && first.size > fs.retained.available) {
      const release = fs.retained.retain(first.size, "search file batch");
      release();
    }
    const batch = fs.readFileHandles(pending, {
      budget: Math.max(1, Math.min(fs.readBudget, fs.retained.available)),
    });
    let held = 0;
    for (const bytes of batch.files.values()) held += bytes.length;
    const release = fs.retained.retain(held, "search file batch");
    try {
      for (const handle of pending) {
        const bytes = batch.files.get(handle.path);
        if (bytes !== undefined) yield { path: handle.path, bytes };
      }
    } finally {
      release();
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
  return new TextEncoder().encode(candidate).length > GLOB_PATTERN_MAX_BYTES ? "*" : candidate;
}

function accepted(
  path: string,
  root: RealPath,
  request: SearchRequest,
  include: ReadonlyArray<{ test(path: string): boolean }>,
  exclude: ReadonlyArray<{ test(path: string): boolean }>,
): boolean {
  if (request.skipHidden) {
    const segments = path.slice(root === "/" ? 1 : root.length + 1).split("/");
    const name = segments.pop() ?? "";
    // A hidden directory is pruned outright: rg never descends into it, so
    // no glob can whitelist what is inside. A hidden *file* is a different
    // case — an explicit `-g`/`-t` filter overrides the skip, and matching
    // that filter is checked below.
    if (segments.some((segment) => segment.startsWith("."))) return false;
    if (name.startsWith(".") && request.include.length === 0) return false;
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
  binary: "report" | "skip",
): Generator<Uint8Array, void, undefined> {
  // Only the line-printing mode substitutes a notice for the content. Both
  // real greps count and list a binary file exactly as they would a text
  // one — `-l` names it and `-c` counts it — because neither answer would
  // put a raw byte on stdout.
  if (request.mode === "content" || binary === "skip") {
    const nul = firstNul(bytes);
    if (nul >= 0) {
      if (binary === "skip") return;
      if (!matchesAnywhere(bytes, request)) return;
      noteMatch();
      const notice = request.reportBinary(path, nul, withFilename);
      if (notice !== null) yield notice;
      return;
    }
  }

  if (request.mode === "files" || request.mode === "files-without-match") {
    const hit = matchesAnywhere(bytes, request);
    // `-L` still exits 0 when the pattern was found: it changes which files
    // are named, not what counts as a match.
    if (hit) noteMatch();
    if (hit === (request.mode === "files")) yield encode(`${path}\n`);
    return;
  }

  const all = [...lines(chunk(bytes))];
  const hits = new Set<number>();
  for (let index = 0; index < all.length; index++) {
    const text = all[index];
    if (text !== undefined && test(text, request)) hits.add(index);
  }

  if (hits.size > 0) noteMatch();

  if (request.mode === "count") {
    if (hits.size === 0 && !request.zeroCounts) return;
    yield encode(withFilename ? `${path}:${hits.size}\n` : `${hits.size}\n`);
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
      // `:` marks a line that matches, whoever's context window emitted it.
      // Keying on the hit being iterated printed the second of two adjacent
      // matches as a context line.
      yield render(path, at + 1, text, hits.has(at), request, withFilename);
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
