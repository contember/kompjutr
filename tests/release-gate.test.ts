// `npm run test:full` gates publication, and tests/pack.test.ts reaches it only
// through hand-written --testNamePattern slices. Nothing else checks that those
// patterns still cover the file, so a new top-level describe would be published
// untested.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const RUNNER = join(ROOT, "scripts", "test-full.mjs");
const PACK_SUITE = join(ROOT, "tests", "pack.test.ts");
const RELEASE_WORKFLOW = join(ROOT, ".github", "workflows", "release.yml");
const PACKAGE_SMOKE = join(ROOT, "scripts", "package-smoke.mjs");
const PACKAGE_NAMES = ["sqlite", "drive", "git", "do", "local"];

function parse(file: string, kind: ts.ScriptKind): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, kind);
}

/** The `packSlices` literal from the runner, read rather than imported: the
 *  module runs the whole suite on load. */
function packSlices(): string[] {
  const source = parse(RUNNER, ts.ScriptKind.JS);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "packSlices") continue;
      const initializer = declaration.initializer;
      if (initializer === undefined || !ts.isArrayLiteralExpression(initializer)) {
        throw new Error("packSlices is no longer an array literal");
      }
      return initializer.elements.map((element) => {
        if (!ts.isStringLiteralLike(element)) throw new Error("packSlices holds a non-literal");
        return element.text;
      });
    }
  }
  throw new Error("packSlices is missing from scripts/test-full.mjs");
}

/** Titles of the top-level `describe` blocks, which is what a `^`-anchored
 *  --testNamePattern matches against. */
function topLevelDescribes(file: string): string[] {
  const source = parse(file, ts.ScriptKind.TS);
  const titles: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
      continue;
    const call = statement.expression;
    const callee = call.expression.getText(source);
    if (callee !== "describe" && !callee.startsWith("describe.")) continue;
    const title = call.arguments[0];
    if (title === undefined || !ts.isStringLiteralLike(title)) {
      throw new Error(`a top-level describe in ${file} has no literal title`);
    }
    titles.push(title.text);
  }
  return titles;
}

describe("the full-suite pack slices", () => {
  it("partition every top-level describe in tests/pack.test.ts", () => {
    const slices = packSlices();
    const titles = topLevelDescribes(PACK_SUITE);
    expect(titles.length).toBeGreaterThan(0);

    const covered = new Set<string>();
    const unmatched: string[] = [];
    const overlapping: string[] = [];
    for (const title of titles) {
      const matching = slices.filter((slice) => new RegExp(`^(${slice})`).test(title));
      for (const slice of matching) covered.add(slice);
      if (matching.length === 0) unmatched.push(title);
      if (matching.length > 1) overlapping.push(title);
    }

    expect(unmatched, "no --testNamePattern slice runs these").toEqual([]);
    expect(overlapping, "more than one slice runs these").toEqual([]);
    expect(
      slices.filter((slice) => !covered.has(slice)),
      "slice matches no describe",
    ).toEqual([]);
  });
});

describe("the scoped-package release gate", () => {
  it("publishes all lockstep artifacts in dependency order", () => {
    const versions = PACKAGE_NAMES.map((name) =>
      JSON.parse(readFileSync(join(ROOT, "packages", name, "package.json"), "utf8")),
    ).map((manifest) => manifest.version);
    expect(new Set(versions).size).toBe(1);

    const workflow = readFileSync(RELEASE_WORKFLOW, "utf8");
    expect(workflow).toContain("for package in sqlite drive git do local");
    expect(workflow).toContain('npm publish "$tarball"');
    expect(workflow).toContain("--access public --provenance");
    expect(workflow).toContain('npm view "$specifier" dist.integrity');
    expect(workflow).toContain('published_integrity" != "$local_integrity');

    const smoke = readFileSync(PACKAGE_SMOKE, "utf8");
    expect(smoke).toContain('const packages = ["sqlite", "drive", "git", "do", "local"]');
    expect(smoke).toContain('"pack", "--json"');
    expect(smoke).toContain('const workerConsumer = join(temporaryRoot, "worker-consumer")');
    expect(smoke).toContain("consumer did not resolve @kompjutr/");
  });
});
