// ADR-0019: source files stay small and cohesive families stay grouped.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const CEILING = 500;
const DIRECTORY_FILE_CEILING = 20;
/**
 * The 99.5th percentile of the measured distribution over src/ (median 8,
 * p90 40, p95 59, p99 117). A round number would have been a guess; this is
 * where the tail starts, and the 18 symbols already past it are named below
 * rather than covered by a higher bar for everyone.
 */
const SYMBOL_CEILING = 173;
const ROOT = join(import.meta.dirname, "..", "src");

/**
 * Long procedures that stay long, each deliberately. A symbol leaving this list
 * must also leave the set — the ratchet only tightens.
 */
const GRANDFATHERED_SYMBOLS: ReadonlySet<string> = new Set([
  // Flat argv/facade dispatch tables: one short handler per command, so the
  // length is the number of commands, not the depth of anything.
  "git/cli/network/network-handlers.ts::createGitCliNetworkHandlers",
  "git/cli/read/read-handlers.ts::createGitCliReadHandlers",
  "git/cli/write/write-refs.ts::createGitCliRefWriteHandlers",
  "fs/filesystem.ts::createFilesystem",
  // A declarative decode schema: one `decodeRow` field per stored column.
  "git/store/maintenance/state/state-view.ts::requireRunView",
  // Linear state machines and single-pass streaming procedures, split further
  // only at the cost of threading their whole cursor state through a seam.
  "git/store/pack/ingest/ingest-pending.ts::PackPendingResolver.drainPending",
  "git/store/pack/read/read-resolver.ts::PackObjectResolver.#readObjects",
  "git/store/pack/ingest/ingest-index.ts::PackIndexer.indexPack",
  "git/store/pack/read/read-graph.ts::PackGraphPager.readObjectsPaged",
  "git/store/objects/objects-write.ts::writeObjectStream",
  "git/store/refs/refs.ts::RefTable.#mutateRefs",
  "git/store/fetch/fetch-publication.ts::FetchPublicationTable.beginFetchPublication",
  "git/store/maintenance/state/state-transitions.ts::rolloverFinishedMaintenanceRun",
  "git/ops/network/network-fetch-legacy.ts::prepareLegacyFetchPublication",
  "git/ops/tree/tree-build-sparse.ts::planSparseTreeBuildOwned",
  "git/diff/myers-search.ts::findSplit",
  // One flag-by-flag option surface each, compared byte-for-byte against the
  // real binaries in tests/shell/parity-{grep,rg}.test.ts.
  "shell/commands/rg.ts::rg",
  "shell/commands/grep.ts::grep",
]);

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** The name a symbol is known by, or undefined when it has none of its own. */
function ownName(node: ts.Node, source: ts.SourceFile): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text;
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    return node.name.getText(source);
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) {
    return parent.name.getText(source);
  }
  return undefined;
}

/**
 * `Class.method`, `factory.handler`, and so on. An anonymous callback has no
 * qualified name and needs none: its lines already count against the named
 * symbol that encloses it.
 */
function qualifiedName(node: ts.Node, source: ts.SourceFile): string | undefined {
  const parts: string[] = [];
  for (let scope: ts.Node | undefined = node; scope !== undefined; scope = scope.parent) {
    if (!isFunctionLike(scope) && !ts.isClassDeclaration(scope)) continue;
    const name = ownName(scope, source);
    if (name === undefined) return undefined;
    parts.unshift(name);
  }
  return parts.join(".");
}

interface MeasuredSymbol {
  readonly key: string;
  readonly lines: number;
}

function measureSymbols(file: string): MeasuredSymbol[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const path = relative(ROOT, file).split(sep).join("/");
  const symbols: MeasuredSymbol[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node) && node.body !== undefined) {
      const name = qualifiedName(node, source);
      if (name !== undefined) {
        const first = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        const last = source.getLineAndCharacterOfPosition(node.getEnd()).line;
        symbols.push({ key: `${path}::${name}`, lines: last - first + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return symbols;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

function* sourceDirectories(dir: string): Generator<string> {
  yield dir;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) yield* sourceDirectories(join(dir, entry.name));
  }
}

describe("source structure ceilings", () => {
  it("keeps every src/ file under 500 lines", () => {
    const over: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const lines = readFileSync(file, "utf8").split("\n").length;
      if (lines >= CEILING) over.push(`${file}: ${lines}`);
    }
    expect(over).toEqual([]);
  });

  /**
   * The file ceiling bounds a file, not the largest thing inside it: a 471-line
   * procedure in a 498-line file passes. Classes are exempt — a table wrapper
   * with thirty short methods is long but not deep; long procedures are.
   */
  it("keeps every function and method under the measured symbol ceiling", () => {
    const over: string[] = [];
    const stale = new Set(GRANDFATHERED_SYMBOLS);
    for (const file of sourceFiles(ROOT)) {
      for (const symbol of measureSymbols(file)) {
        if (symbol.lines < SYMBOL_CEILING) continue;
        stale.delete(symbol.key);
        if (!GRANDFATHERED_SYMBOLS.has(symbol.key)) over.push(`${symbol.key}: ${symbol.lines}`);
      }
    }
    expect(over).toEqual([]);
    expect([...stale], "shrunk below the ceiling; drop from GRANDFATHERED_SYMBOLS").toEqual([]);
  });

  it("keeps at most 20 direct TypeScript files in every src/ directory", () => {
    const over: string[] = [];
    for (const directory of sourceDirectories(ROOT)) {
      const files = readdirSync(directory, { withFileTypes: true }).filter(
        (entry) => entry.isFile() && entry.name.endsWith(".ts"),
      ).length;
      if (files > DIRECTORY_FILE_CEILING) over.push(`${directory}: ${files}`);
    }
    expect(over).toEqual([]);
  });
});
