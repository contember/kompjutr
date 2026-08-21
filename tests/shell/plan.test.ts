// Planning is pure, so these run with no database. Every case is a pipeline
// shape counted in the corpus behind docs/plans/shell.md §1.3.

import { describe, expect, it } from "vitest";

import { ShellSyntaxError } from "../../src/shell/parse/ast.js";
import { parse } from "../../src/shell/parse/parser.js";
import { planScript } from "../../src/shell/plan/plan.js";
import type { Argument, PlannedPipeline } from "../../src/shell/plan/types.js";

function planOne(source: string): PlannedPipeline {
  const plan = planScript(parse(source));
  const first = plan.steps[0];
  if (first === undefined) throw new Error("no steps");
  return first.pipeline;
}

function names(pipeline: PlannedPipeline): string[] {
  return pipeline.commands.map((command) => command.name);
}

function text(args: readonly Argument[]): string[] {
  return args.map((arg) => (arg.kind === "literal" ? arg.value : `glob:${arg.pattern}`));
}

function rejects(source: string): ShellSyntaxError {
  try {
    planScript(parse(source));
  } catch (error) {
    if (error instanceof ShellSyntaxError) return error;
    throw error;
  }
  throw new Error(`expected ${source} to be rejected`);
}

describe("R1 — a trailing head becomes demand", () => {
  it("lifts the most common corpus shape", () => {
    const pipeline = planOne("grep -rn pattern . | head -20");
    expect(names(pipeline)).toEqual(["grep"]);
    expect(pipeline.limitHint).toBe(20);
    expect(pipeline.fusions).toContain("head -20 lifted into a demand hint");
  });

  it("reads every spelling of the count", () => {
    expect(planOne("ls | head -5").limitHint).toBe(5);
    expect(planOne("ls | head -n 5").limitHint).toBe(5);
    expect(planOne("ls | head -n5").limitHint).toBe(5);
    expect(planOne("ls | head").limitHint).toBe(10);
  });

  it("keeps head as a stage when a blocking stage swallows the demand", () => {
    // `find | sort | head -20` genuinely needs all of find's output; lifting
    // the limit past `sort` would return the wrong twenty lines.
    const pipeline = planOne("find . -name '*.ts' | sort | head -20");
    expect(names(pipeline)).toEqual(["find", "sort", "head"]);
    expect(pipeline.limitHint).toBeNull();
  });

  it("does not lift tail", () => {
    // `tail` needs the end of its input, so it cannot bound the source.
    const pipeline = planOne("cat log | tail -20");
    expect(names(pipeline)).toEqual(["cat", "tail"]);
    expect(pipeline.limitHint).toBeNull();
  });

  it("does not lift a byte-bounded head", () => {
    expect(planOne("cat f | head -c 100").limitHint).toBeNull();
  });

  it("leaves head alone when it names a file", () => {
    // `head -20 file` is a source, not a limiter.
    const pipeline = planOne("head -20 file.txt");
    expect(names(pipeline)).toEqual(["head"]);
    expect(pipeline.limitHint).toBeNull();
  });

  it("leaves a lone head alone", () => {
    expect(planOne("head -5").limitHint).toBeNull();
  });
});

describe("R2 — find | xargs grep is one search", () => {
  it("fuses the observed shape", () => {
    const pipeline = planOne("find /repo -name '*.ts' | xargs grep -l needle");
    expect(names(pipeline)).toEqual(["grep"]);
    expect(text(pipeline.commands[0]!.args)).toEqual([
      "-r",
      "-l",
      "needle",
      "--include=*.ts",
      "/repo",
    ]);
    expect(pipeline.fusions[0]).toContain("fused into one search");
  });

  it("fuses into rg with its own flag spelling", () => {
    const pipeline = planOne("find /repo -name '*.ts' | xargs rg needle");
    expect(text(pipeline.commands[0]!.args)).toEqual(["needle", "-g", "*.ts", "/repo"]);
    // rg is recursive by default, so no -r is added.
    expect(text(pipeline.commands[0]!.args)).not.toContain("-r");
  });

  it("keeps a trailing stage after the fusion", () => {
    const pipeline = planOne("find /repo -name '*.ts' | xargs grep -l x | sort");
    expect(names(pipeline)).toEqual(["grep", "sort"]);
  });

  it("composes with R1", () => {
    const pipeline = planOne("find /repo -name '*.ts' | xargs grep -l x | head -20");
    expect(names(pipeline)).toEqual(["grep"]);
    expect(pipeline.limitHint).toBe(20);
    expect(pipeline.fusions).toHaveLength(2);
  });

  it("tolerates -type f, which a search implies anyway", () => {
    const pipeline = planOne("find /repo -type f -name '*.ts' | xargs grep x");
    expect(names(pipeline)).toEqual(["grep"]);
  });

  it("refuses to guess at a find it does not fully understand", () => {
    // `xargs grep …` is one stage — the search is xargs's argument. Extra
    // predicates change which files are searched, so leaving the pipeline
    // alone is correct; fusing and dropping the predicate would not be.
    expect(names(planOne("find /repo -mtime -1 | xargs grep x"))).toEqual(["find", "xargs"]);
    expect(names(planOne("find /repo -name '*.ts' | xargs -n1 grep x"))).toEqual(["find", "xargs"]);
    expect(names(planOne("find /repo -name '*.ts' | xargs cat"))).toEqual(["find", "xargs"]);
  });
});

describe("R4 — redirections become flags", () => {
  it("recognises the stderr sink instead of buffering it", () => {
    const pipeline = planOne("grep -r x . 2>/dev/null");
    expect(pipeline.commands[0]?.stderr).toBe("drop");
  });

  it("recognises the merge", () => {
    expect(planOne("bun run build 2>&1").commands[0]?.stderr).toBe("merge");
  });

  it("carries a stdout file target", () => {
    const target = planOne("echo hi > out.txt").commands[0]?.stdout;
    expect(target?.append).toBe(false);
    expect(target?.path).toEqual({ kind: "literal", value: "out.txt" });
    expect(planOne("echo hi >> out.txt").commands[0]?.stdout?.append).toBe(true);
  });

  it("refuses a stderr redirection it cannot honour", () => {
    expect(rejects("ls 2> errors.log").construct).toBe("redirection");
    expect(rejects("ls 3> x").construct).toBe("redirection");
    expect(rejects("ls 1>&2").construct).toBe("redirection");
  });
});

describe("arguments", () => {
  it("marks an unquoted glob for the executor to expand", () => {
    expect(text(planOne("ls *.ts").commands[0]!.args)).toEqual(["glob:*.ts"]);
  });

  it("leaves a quoted glob literal", () => {
    expect(text(planOne("find . -name '*.ts'").commands[0]!.args)).toEqual([".", "-name", "*.ts"]);
  });

  it("escapes the quoted half of a mixed word", () => {
    // `"a*b"*` matches a literal `a*b` followed by anything.
    expect(text(planOne('ls "a*b"*').commands[0]!.args)).toEqual(["glob:a[*]b*"]);
  });
});

describe("statements", () => {
  it("keeps the connector so the executor can short-circuit", () => {
    const plan = planScript(parse("cd /repo && grep -r x . | head -20"));
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.connector).toBe("&&");
    expect(plan.steps[1]?.pipeline.limitHint).toBe(20);
  });
});
