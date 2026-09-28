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

type GitSlice = "common" | "diff" | "ignore" | "protocol" | "store" | "do-fs" | "ops" | "surface";

// diff, ignore and protocol share a rank, so an edge between two of them fails.
const GIT_SLICE_RANK: Readonly<Record<Exclude<GitSlice, "do-fs">, number>> = {
  common: 0,
  diff: 1,
  ignore: 1,
  protocol: 1,
  store: 2,
  ops: 3,
  surface: 4,
};

type DoDomain = "db" | "fs" | "shell" | "runtime" | "entry";

const DO_DOMAIN_IMPORTS: Readonly<Record<DoDomain, ReadonlySet<DoDomain>>> = {
  db: new Set(["db"]),
  fs: new Set(["fs", "db"]),
  shell: new Set(["shell", "fs", "db"]),
  runtime: new Set(["runtime", "db", "fs", "shell"]),
  entry: new Set(["db", "fs", "shell", "runtime", "entry"]),
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

function importEdges(file: string, text = fs.readFileSync(file, "utf8")): Edge[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
  if (
    segment === "common" ||
    segment === "diff" ||
    segment === "ignore" ||
    segment === "protocol" ||
    segment === "store" ||
    segment === "do-fs" ||
    segment === "ops"
  ) {
    return segment;
  }
  return "surface";
}

function doDomain(file: SourceFile): DoDomain | null {
  if (file.packageName !== "do") return null;
  if (!file.packagePath.includes("/")) return "entry";
  const segment = file.packagePath.split("/", 1)[0];
  if (segment === "db" || segment === "fs" || segment === "shell" || segment === "runtime") {
    return segment;
  }
  return null;
}

function sourceFile(id: string): SourceFile {
  const [packageName = "", , ...rest] = id.split("/");
  return {
    absolute: path.join(PACKAGES_ROOT, ...id.split("/")),
    id,
    packageName,
    packagePath: rest.join("/"),
  };
}

function violation(file: SourceFile, specifier: string, reason: string): string {
  return `${file.id} imports "${specifier}": ${reason}`;
}

/** The source file an in-repository import names, through a relative path or a public entry. */
function importTarget(
  file: SourceFile,
  specifier: string,
  byId: ReadonlyMap<string, SourceFile>,
): SourceFile | undefined {
  const relative = relativeTarget(file, specifier);
  if (relative !== null) return byId.get(relative);
  const entry = ENTRY_FILES.get(specifier);
  return entry === undefined ? undefined : byId.get(entry);
}

function doDomainViolation(file: SourceFile, target: SourceFile): string | null {
  const source = doDomain(file);
  if (source === null) return null;
  if (target.packageName === "git") {
    return source === "runtime" || source === "entry"
      ? null
      : `do/${source} may not import @kompjutr/git`;
  }
  if (target.packageName !== "do") return null;
  const targetDomain = doDomain(target);
  if (targetDomain === null) return "import target is outside a DO domain";
  return DO_DOMAIN_IMPORTS[source].has(targetDomain)
    ? null
    : `do/${source} may not import do/${targetDomain}`;
}

function gitSliceViolation(file: SourceFile, target: SourceFile): string | null {
  const sourceSlice = gitSlice(file);
  const targetSlice = gitSlice(target);
  if (sourceSlice === null || targetSlice === null || sourceSlice === targetSlice) return null;
  if (targetSlice === "do-fs") return "ordinary Git code may not reach do-fs";
  if (sourceSlice === "do-fs") {
    return targetSlice === "ops" || targetSlice === "surface"
      ? "do-fs may import only common and store layers"
      : null;
  }
  return GIT_SLICE_RANK[targetSlice] >= GIT_SLICE_RANK[sourceSlice]
    ? `Git ${sourceSlice} may not import Git ${targetSlice}`
    : null;
}

function edgeViolations(
  file: SourceFile,
  specifier: string,
  byId: ReadonlyMap<string, SourceFile>,
): string[] {
  const reasons: string[] = [];
  if (specifier === "@cloudflare/computer" || specifier.startsWith("@cloudflare/computer/")) {
    reasons.push("source packages may not import the test oracle");
  }

  const importedPackage = packageSpecifier(specifier);
  if (
    importedPackage !== null &&
    importedPackage !== file.packageName &&
    !PACKAGE_IMPORTS[file.packageName]?.has(importedPackage)
  ) {
    reasons.push("package dependency points outside its layer");
  }
  if (specifier === "@kompjutr/git/do-fs" && file.packageName !== "do") {
    reasons.push("only @kompjutr/do may compose the DO integration");
  }

  if (specifier.startsWith("node:")) {
    const allowed =
      file.packageName === "local" ||
      (file.id === "git/src/common/zlib.ts" && specifier === "node:zlib") ||
      (file.id === "do/src/fs/compat/node-path.ts" && specifier === "node:buffer");
    if (!allowed) reasons.push("Node builtin is not Worker-safe");
  }

  const relative = relativeTarget(file, specifier);
  if (relative !== null) {
    const target = byId.get(relative);
    if (target === undefined) {
      reasons.push("relative import does not resolve to package source");
      return reasons;
    }
    if (target.packageName !== file.packageName) {
      reasons.push("cross-package source imports must use public exports");
      return reasons;
    }
  }

  const target = importTarget(file, specifier, byId);
  if (target === undefined) return reasons;
  const domainReason = doDomainViolation(file, target);
  if (domainReason !== null) reasons.push(domainReason);
  const sliceReason = gitSliceViolation(file, target);
  if (sliceReason !== null) reasons.push(sliceReason);
  return reasons;
}

it("keeps source imports inside the package, Git layer and DO domain graph", () => {
  const violations: string[] = [];
  const files = allSourceFiles();
  const byId = new Map(files.map((file) => [file.id, file]));

  for (const file of files) {
    if (file.packageName === "do" && doDomain(file) === null) {
      violations.push(`${file.id}: DO source is outside a domain`);
    }
    for (const { specifier } of importEdges(file.absolute)) {
      for (const reason of edgeViolations(file, specifier, byId)) {
        violations.push(violation(file, specifier, reason));
      }
    }
  }

  expect(violations).toEqual([]);
});

it("applies the Git peer and DO domain rules to fixture edges", () => {
  const byId = new Map(
    [
      "git/src/common/bytes.ts",
      "git/src/diff/a.ts",
      "git/src/ignore/b.ts",
      "git/src/protocol/c.ts",
      "git/src/store/d.ts",
      "git/src/index.ts",
      "git/src/do-fs/index.ts",
      "do/src/db/db.ts",
      "do/src/fs/filesystem.ts",
      "do/src/fs/index.ts",
      "do/src/shell/index.ts",
      "do/src/shell/run.ts",
      "do/src/runtime/index.ts",
      "do/src/index.ts",
      "sqlite/src/index.ts",
      "drive/src/index.ts",
    ].map((id) => [id, sourceFile(id)]),
  );
  const reasons = (from: string, specifier: string): string[] =>
    edgeViolations(sourceFile(from), specifier, byId);

  const allowed: ReadonlyArray<readonly [string, string]> = [
    ["git/src/diff/a.ts", "../common/bytes.js"],
    ["git/src/store/d.ts", "../protocol/c.js"],
    ["do/src/db/db.ts", "@kompjutr/sqlite"],
    ["do/src/fs/filesystem.ts", "../db/db.js"],
    ["do/src/fs/filesystem.ts", "@kompjutr/drive"],
    ["do/src/shell/run.ts", "../fs/filesystem.js"],
    ["do/src/shell/run.ts", "@kompjutr/do/fs"],
    ["do/src/runtime/index.ts", "../shell/index.js"],
    ["do/src/runtime/index.ts", "@kompjutr/git"],
    ["do/src/runtime/index.ts", "@kompjutr/git/do-fs"],
    ["do/src/index.ts", "./runtime/index.js"],
    ["do/src/index.ts", "@kompjutr/git"],
  ];
  for (const [from, specifier] of allowed) expect(reasons(from, specifier)).toEqual([]);

  const rejected: ReadonlyArray<readonly [string, string, string]> = [
    ["git/src/diff/a.ts", "../ignore/b.js", "Git diff may not import Git ignore"],
    ["git/src/ignore/b.ts", "../protocol/c.js", "Git ignore may not import Git protocol"],
    ["git/src/protocol/c.ts", "../diff/a.js", "Git protocol may not import Git diff"],
    ["do/src/db/db.ts", "../fs/filesystem.js", "do/db may not import do/fs"],
    ["do/src/fs/filesystem.ts", "../shell/index.js", "do/fs may not import do/shell"],
    ["do/src/fs/filesystem.ts", "@kompjutr/do/shell", "do/fs may not import do/shell"],
    ["do/src/fs/filesystem.ts", "@kompjutr/git", "do/fs may not import @kompjutr/git"],
    ["do/src/shell/run.ts", "@kompjutr/git", "do/shell may not import @kompjutr/git"],
    ["do/src/shell/run.ts", "@kompjutr/git/do-fs", "do/shell may not import @kompjutr/git"],
    ["do/src/shell/run.ts", "../runtime/index.js", "do/shell may not import do/runtime"],
    ["do/src/runtime/index.ts", "../index.js", "do/runtime may not import do/entry"],
  ];
  for (const [from, specifier, reason] of rejected) {
    expect(reasons(from, specifier)).toContain(reason);
  }

  const typeOnly = importEdges(
    sourceFile("do/src/fs/filesystem.ts").absolute,
    'import type { Shell } from "../shell/index.js";',
  );
  expect(typeOnly).toEqual([{ specifier: "../shell/index.js", typeOnly: true }]);
  for (const { specifier } of typeOnly) {
    expect(reasons("do/src/fs/filesystem.ts", specifier)).toContain(
      "do/fs may not import do/shell",
    );
  }
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
