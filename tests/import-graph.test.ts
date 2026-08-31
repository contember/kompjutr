import fs from "node:fs";
import path from "node:path";

import * as ts from "typescript";
import { expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(process.cwd(), "src");
const DOMAIN_DIRECTORIES = new Set(["db", "fs", "shell", "git", "runtime", "compat"]);

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

function importSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        specifiers.push(argument.text);
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
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
    for (const specifier of importSpecifiers(absoluteFile)) {
      if (
        (specifier === "@cloudflare/computer" || specifier.startsWith("@cloudflare/computer/")) &&
        sourceDomain !== "compat"
      ) {
        violations.push(
          violation(file, specifier, "only src/compat may import @cloudflare/computer"),
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
