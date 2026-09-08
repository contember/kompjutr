import fs from "node:fs";
import path from "node:path";

import * as ts from "typescript";
import { expect, it } from "vitest";

const PACKAGES_ROOT = path.resolve(process.cwd(), "packages");
const SOURCE_ROOTS = new Map(
  ["sqlite", "drive", "git", "do", "local"].map((name) => [
    name,
    path.join(PACKAGES_ROOT, name, "src"),
  ]),
);
const PACKAGE_IMPORTS: Readonly<Record<string, ReadonlySet<string>>> = {
  sqlite: new Set(),
  drive: new Set(),
  git: new Set(["sqlite", "drive"]),
  do: new Set(["sqlite", "drive", "git"]),
  local: new Set(["sqlite", "drive", "git"]),
};
const ENTRY_FILES = new Map([
  ["@kompjutr/sqlite", "sqlite/src/index.ts"],
  ["@kompjutr/drive", "drive/src/index.ts"],
  ["@kompjutr/git", "git/src/index.ts"],
  ["@kompjutr/git/do-fs", "git/src/do-fs/index.ts"],
  ["@kompjutr/do", "do/src/index.ts"],
  ["@kompjutr/do/fs", "do/src/fs/index.ts"],
  ["@kompjutr/do/shell", "do/src/shell/index.ts"],
  ["@kompjutr/do/git-shell", "do/src/git-shell.ts"],
  ["@kompjutr/do/testing", "do/src/testing.ts"],
  ["@kompjutr/local", "local/src/index.ts"],
]);

type GitSlice = "common" | "algorithm" | "store" | "do-fs" | "ops" | "surface";

const GIT_SLICE_RANK: Readonly<Record<Exclude<GitSlice, "do-fs">, number>> = {
  common: 0,
  algorithm: 1,
  store: 2,
  ops: 3,
  surface: 4,
};

interface SourceFile {
  readonly absolute: string;
  readonly id: string;
  readonly packageName: string;
  readonly packagePath: string;
}

interface Edge {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(file));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(file);
  }
  return files;
}

function allSourceFiles(): SourceFile[] {
  return [...SOURCE_ROOTS].flatMap(([packageName, root]) =>
    sourceFiles(root).map((absolute) => {
      const packagePath = path.relative(root, absolute).split(path.sep).join("/");
      return { absolute, id: `${packageName}/src/${packagePath}`, packageName, packagePath };
    }),
  );
}

function importClauseIsTypeOnly(clause: ts.ImportClause): boolean {
  if (clause.isTypeOnly) return true;
  if (clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return false;
  return bindings.elements.every((element) => element.isTypeOnly);
}

function exportDeclarationIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
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

function packageSpecifier(specifier: string): string | null {
  const match = /^@kompjutr\/([^/]+)/.exec(specifier);
  return match?.[1] ?? null;
}

function relativeTarget(file: SourceFile, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const unresolved = path.resolve(path.dirname(file.absolute), specifier);
  const resolved = unresolved.endsWith(".js") ? `${unresolved.slice(0, -3)}.ts` : unresolved;
  const relative = path.relative(PACKAGES_ROOT, resolved);
  return relative === ".." || relative.startsWith(`..${path.sep}`)
    ? null
    : relative.split(path.sep).join("/");
}

function gitSlice(file: SourceFile): GitSlice | null {
  if (file.packageName !== "git") return null;
  const segment = file.packagePath.split("/", 1)[0];
  if (segment === "common") return "common";
  if (segment === "diff" || segment === "ignore" || segment === "protocol") return "algorithm";
  if (segment === "store") return "store";
  if (segment === "do-fs") return "do-fs";
  if (segment === "ops") return "ops";
  return "surface";
}

function violation(file: SourceFile, specifier: string, reason: string): string {
  return `${file.id} imports "${specifier}": ${reason}`;
}

it("keeps source imports inside the package and Git layer graph", () => {
  const violations: string[] = [];
  const files = allSourceFiles();
  const byId = new Map(files.map((file) => [file.id, file]));

  for (const file of files) {
    for (const { specifier } of importEdges(file.absolute)) {
      if (specifier === "@cloudflare/computer" || specifier.startsWith("@cloudflare/computer/")) {
        violations.push(
          violation(file, specifier, "source packages may not import the test oracle"),
        );
      }

      const importedPackage = packageSpecifier(specifier);
      if (
        importedPackage !== null &&
        importedPackage !== file.packageName &&
        !PACKAGE_IMPORTS[file.packageName]?.has(importedPackage)
      ) {
        violations.push(violation(file, specifier, "package dependency points outside its layer"));
      }
      if (specifier === "@kompjutr/git/do-fs" && file.packageName !== "do") {
        violations.push(
          violation(file, specifier, "only @kompjutr/do may compose the DO integration"),
        );
      }

      if (specifier.startsWith("node:")) {
        const allowed =
          file.packageName === "local" ||
          (file.id === "git/src/common/zlib.ts" && specifier === "node:zlib") ||
          (file.id === "do/src/fs/compat/node-path.ts" && specifier === "node:buffer");
        if (!allowed)
          violations.push(violation(file, specifier, "Node builtin is not Worker-safe"));
      }

      const targetId = relativeTarget(file, specifier);
      if (targetId === null) continue;
      const target = byId.get(targetId);
      if (target === undefined) {
        violations.push(
          violation(file, specifier, "relative import does not resolve to package source"),
        );
        continue;
      }
      if (target.packageName !== file.packageName) {
        violations.push(
          violation(file, specifier, "cross-package source imports must use public exports"),
        );
        continue;
      }

      const sourceSlice = gitSlice(file);
      const targetSlice = gitSlice(target);
      if (sourceSlice === null || targetSlice === null || sourceSlice === targetSlice) continue;
      if (targetSlice === "do-fs" && sourceSlice !== "do-fs") {
        violations.push(violation(file, specifier, "ordinary Git code may not reach do-fs"));
      } else if (sourceSlice === "do-fs") {
        if (targetSlice === "ops" || targetSlice === "surface") {
          violations.push(
            violation(file, specifier, "do-fs may import only common and store layers"),
          );
        }
      } else if (
        targetSlice !== "do-fs" &&
        GIT_SLICE_RANK[targetSlice] >= GIT_SLICE_RANK[sourceSlice]
      ) {
        violations.push(
          violation(file, specifier, `Git ${sourceSlice} may not import Git ${targetSlice}`),
        );
      }
    }
  }

  expect(violations).toEqual([]);
});

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

it("keeps the value-import graph acyclic", () => {
  const files = allSourceFiles();
  const byId = new Map(files.map((file) => [file.id, file]));
  const edges = new Map<string, readonly string[]>();

  for (const file of files) {
    const targets = new Set<string>();
    for (const { specifier, typeOnly } of importEdges(file.absolute)) {
      if (typeOnly) continue;
      const relative = relativeTarget(file, specifier);
      const target = relative ?? ENTRY_FILES.get(specifier) ?? null;
      if (target !== null && target !== file.id && byId.has(target)) targets.add(target);
    }
    edges.set(file.id, [...targets]);
  }

  expect(valueCycles(edges)).toEqual([]);
});
