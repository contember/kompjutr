import fs from "node:fs";
import path from "node:path";

import * as ts from "typescript";
import { expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(process.cwd(), "src");
const DOMAIN_DIRECTORIES = new Set(["db", "fs", "shell", "git", "runtime"]);
const RUNTIME_IMPORTABLE = new Set(["runtime", "db", "fs", "git", "shell"]);

type GitSlice = "common" | "diff" | "ignore" | "protocol" | "store" | "ops" | "surface";

const GIT_SLICE_RANK: Readonly<Record<GitSlice, number>> = {
  common: 0,
  diff: 1,
  ignore: 1,
  protocol: 1,
  store: 2,
  ops: 3,
  surface: 4,
};

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(file));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(file);
  }
  return files;
}

/** An edge is type-only when nothing it names survives to runtime. */
interface Edge {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

function importClauseIsTypeOnly(clause: ts.ImportClause): boolean {
  if (clause.isTypeOnly) return true;
  // A default or namespace binding is a value; only a fully `type`-marked
  // named clause elides.
  if (clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return false;
  return bindings.elements.every((element) => element.isTypeOnly);
}

function exportDeclarationIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  // `export * from` re-exports values.
  if (clause === undefined || !ts.isNamedExports(clause)) return false;
  return clause.elements.every((element) => element.isTypeOnly);
}

function importEdges(file: string): Edge[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const edges: Edge[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      edges.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: clause !== undefined && importClauseIsTypeOnly(clause),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      edges.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: exportDeclarationIsTypeOnly(node),
      });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        edges.push({ specifier: argument.text, typeOnly: false });
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      edges.push({ specifier: node.argument.literal.text, typeOnly: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

function sourcePath(file: string): string {
  return path.relative(SOURCE_ROOT, file).split(path.sep).join("/");
}

function relativeTarget(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const unresolved = path.resolve(path.dirname(file), specifier);
  const resolved = unresolved.endsWith(".js") ? `${unresolved.slice(0, -3)}.ts` : unresolved;
  const relative = path.relative(SOURCE_ROOT, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  return relative.split(path.sep).join("/");
}

function domain(file: string): string {
  return file.split("/", 1)[0] ?? "";
}

function gitSlice(file: string): GitSlice | null {
  if (domain(file) !== "git") return null;
  const segment = file.split("/")[1];
  if (
    segment === "common" ||
    segment === "diff" ||
    segment === "ignore" ||
    segment === "protocol" ||
    segment === "store" ||
    segment === "ops"
  ) {
    return segment;
  }
  return "surface";
}

function violation(file: string, specifier: string, reason: string): string {
  return `${file} imports "${specifier}": ${reason}`;
}

it("keeps source imports inside the domain dependency graph", () => {
  const violations: string[] = [];

  for (const absoluteFile of sourceFiles(SOURCE_ROOT)) {
    const file = sourcePath(absoluteFile);
    const sourceDomain = domain(file);
    for (const { specifier } of importEdges(absoluteFile)) {
      if (specifier === "@cloudflare/computer" || specifier.startsWith("@cloudflare/computer/")) {
        violations.push(
          violation(file, specifier, "no file under src/ may import @cloudflare/computer"),
        );
      }

      const target = relativeTarget(absoluteFile, specifier);
      if (target === null) continue;
      const targetDomain = domain(target);

      if (sourceDomain === "db" && DOMAIN_DIRECTORIES.has(targetDomain) && targetDomain !== "db") {
        violations.push(violation(file, specifier, "src/db may not import a domain"));
      }
      if (sourceDomain === "fs" && targetDomain !== "fs" && targetDomain !== "db") {
        violations.push(violation(file, specifier, "src/fs may import only src/fs or src/db"));
      }
      if (
        sourceDomain === "shell" &&
        targetDomain !== "shell" &&
        targetDomain !== "fs" &&
        targetDomain !== "db"
      ) {
        violations.push(
          violation(file, specifier, "src/shell may import only src/shell, src/fs, or src/db"),
        );
      }
      if (sourceDomain === "runtime" && !RUNTIME_IMPORTABLE.has(targetDomain)) {
        violations.push(
          violation(
            file,
            specifier,
            "src/runtime may import only src/runtime, src/db, src/fs, src/git, or src/shell",
          ),
        );
      }

      const sourceSlice = gitSlice(file);
      const targetSlice = gitSlice(target);
      if (sourceSlice !== null && targetSlice !== null && sourceSlice !== targetSlice) {
        if (GIT_SLICE_RANK[targetSlice] >= GIT_SLICE_RANK[sourceSlice]) {
          violations.push(
            violation(
              file,
              specifier,
              `git/${sourceSlice} may import only lower git slices, not git/${targetSlice}`,
            ),
          );
        }
      }
      if (file.startsWith("git/store/") && target.startsWith("git/ops/")) {
        violations.push(violation(file, specifier, "src/git/store may not import src/git/ops"));
      }
    }
  }

  expect(violations).toEqual([]);
});

/**
 * Strongly connected components of the value-import graph. Tarjan's algorithm;
 * a component of more than one file is a cycle.
 */
function valueCycles(edges: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let next = 0;

  const visit = (file: string): void => {
    index.set(file, next);
    lowlink.set(file, next);
    next++;
    stack.push(file);
    onStack.add(file);
    for (const target of edges.get(file) ?? []) {
      const targetIndex = index.get(target);
      if (targetIndex === undefined) {
        visit(target);
        lowlink.set(file, Math.min(lowlink.get(file) ?? 0, lowlink.get(target) ?? 0));
      } else if (onStack.has(target)) {
        lowlink.set(file, Math.min(lowlink.get(file) ?? 0, targetIndex));
      }
    }
    if (lowlink.get(file) !== index.get(file)) return;
    const component: string[] = [];
    for (;;) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
      if (member === file) break;
    }
    if (component.length > 1) cycles.push(component.sort());
  };

  for (const file of edges.keys()) if (!index.has(file)) visit(file);
  return cycles;
}

/**
 * Type-only cycles are harmless — they vanish at compile time, and five of them
 * exist here. Only edges that survive to runtime are counted, because only
 * those can produce a partially initialised module at import time.
 */
it("keeps the value-import graph acyclic", () => {
  const edges = new Map<string, readonly string[]>();

  for (const absoluteFile of sourceFiles(SOURCE_ROOT)) {
    const file = sourcePath(absoluteFile);
    const targets = new Set<string>();
    for (const { specifier, typeOnly } of importEdges(absoluteFile)) {
      if (typeOnly) continue;
      const target = relativeTarget(absoluteFile, specifier);
      if (target === null || target === file) continue;
      targets.add(target);
    }
    edges.set(file, [...targets]);
  }

  expect(valueCycles(edges)).toEqual([]);
});
