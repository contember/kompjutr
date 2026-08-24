import { describe, expect, it } from "vitest";

import {
  type GitParityScenario,
  runGitParityScenario,
  UPSTREAM_GIT_REVISION,
} from "./helpers/git-parity.js";

const scenarios: GitParityScenario[] = [
  {
    source: { file: "t/t3700-add.sh", test: ".gitignore is honored" },
    steps: [
      { op: "write", path: ".gitignore", content: "*.ig\n" },
      { op: "write", path: "a.ig", content: "" },
      { op: "write", path: "b.if", content: "" },
      { op: "write", path: "c.if/c.if", content: "" },
      { op: "write", path: "c.if/c.ig", content: "" },
      { op: "write", path: "d.ig/d.if", content: "" },
      { op: "write", path: "d.ig/d.ig", content: "" },
      { op: "add", paths: ["."] },
    ],
  },
  {
    source: { file: "t/t7102-reset.sh", test: "disambiguation (4)" },
    steps: [
      { op: "write", path: "tracked", content: "base\n" },
      { op: "add", paths: ["tracked"] },
      { op: "commit", message: "base" },
      { op: "write", path: "secondfile", content: "" },
      { op: "add", paths: ["secondfile"] },
      { op: "remove", path: "secondfile" },
      { op: "reset", paths: ["secondfile"] },
    ],
  },
  {
    source: { file: "t/t7201-co.sh", test: "checkout with dirty tree without -m" },
    steps: [
      { op: "write", path: "one", content: "base\n" },
      { op: "add", paths: ["one"] },
      { op: "commit", message: "base" },
      { op: "branch", name: "side" },
      { op: "checkout", ref: "side" },
      { op: "write", path: "one", content: "side\n" },
      { op: "add", paths: ["one"] },
      { op: "commit", message: "side" },
      { op: "checkout", ref: "main" },
      { op: "write", path: "one", content: "local\n" },
      {
        op: "checkout",
        ref: "side",
        expected: { outcome: "failure", kompjutrCode: "ECHECKOUTFAIL" },
      },
    ],
  },
  {
    source: {
      file: "t/t7300-clean.sh",
      test: "git clean -d skips untracked dirs containing ignored files",
    },
    steps: [
      { op: "write", path: ".gitignore", content: "/foo/bar\nignoreme\n" },
      { op: "add", paths: [".gitignore"] },
      { op: "commit", message: "ignore rules" },
      { op: "mkdir", path: "foo/a/aa/aaa" },
      { op: "write", path: "foo/bar", content: "" },
      { op: "write", path: "foo/baz", content: "" },
      { op: "write", path: "foo/a/aa/ignoreme", content: "" },
      { op: "write", path: "foo/b/ignoreme", content: "" },
      { op: "write", path: "foo/b/bb/1", content: "" },
      { op: "write", path: "foo/b/bb/2", content: "" },
      { op: "clean", directories: true },
    ],
  },
];

describe(`upstream Git scenarios at ${UPSTREAM_GIT_REVISION}`, () => {
  for (const scenario of scenarios) {
    it(`${scenario.source.file}: ${scenario.source.test}`, async () => {
      const result = await runGitParityScenario(scenario);
      expect(result.kompjutr).toEqual(result.git);
    });
  }
});
