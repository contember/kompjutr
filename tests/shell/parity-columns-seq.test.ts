// `seq` against uutils seq 0.2.2 through Bash: exact decimal steps, the
// precision and `-w` width read from the operands' spelling, separators, and
// `-f` with `%f`, `%e`, `%g`, flags, width, and precision, including the
// reference's rounding and its directive diagnostics.

import { describe, expect, it } from "vitest";

import { agreeWithBash, compareWithBash, REAL_BASH } from "../helpers/shell-parity.js";

describe("the seq parity suite has something to compare against", () => {
  it("found GNU bash", () => {
    expect(REAL_BASH).toBe(true);
  });
});

describe.skipIf(!REAL_BASH)("seq matches uutils seq", () => {
  async function compare(source: string): Promise<void> {
    agreeWithBash(await compareWithBash(source));
  }

  it.each([
    "seq 3",
    "seq 0",
    "seq -1",
    "seq 2 4",
    "seq 5 1",
    "seq 5 -2 0",
    "seq 3 -1 1",
    "seq 1 -1 3",
    "seq -1 1",
    "seq -- -1 1",
    "seq -3 2 3",
    "seq 1 0.5 3",
    "seq 0.1 0.1 0.5",
    "seq 1 0.1 1.3",
    "seq 0.10 0.10 0.3",
    "seq 10 -2.5 1",
    "seq 1.5 1 3.4",
    "seq 1 2.5",
    "seq .5 2",
    "seq -.5 1",
    "seq 5.",
    "seq +3",
    "seq ' +3'",
    "seq 1e2 1e2",
    "seq 1.5e1 16",
    "seq 1E1",
    "seq 1 1e0 3",
    "seq 1 0.1e1 3",
    "seq 1e-1 0.1 0.3",
    "seq 1e-20 1",
    "seq -0 1",
    "seq -0.0 1",
    "seq 99999999999999999999 100000000000000000001",
    "seq 1 1000 | tail -1",
  ])("counts: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "seq -w 8 10",
    "seq -w -5 3 5",
    "seq -w -1 1 10",
    "seq -w 1 -1 -3",
    "seq -w 0.5 0.25 1",
    "seq -w -0.5 0.5 1",
    "seq -w -0 2",
    "seq -w 1e1 11",
    "seq --equal-width 9 10",
    "seq --equal 9 10",
    "seq -s, 3",
    "seq -s ', ' 1 3",
    "seq -s '' 3",
    "seq --separator=: 3",
    "seq --sep=: 3",
    "seq -s, -w 9 10",
    "seq -t X 2",
    "seq -tX -s: 3",
    "seq --terminator=';' 0",
  ])("lays out: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "seq -f %g 1 0.5 2",
    "seq -f %f 1 2",
    "seq -f %e 1 2",
    "seq -f %E 1 1",
    "seq -f %F 1 1",
    "seq -f %G 1e10 1e10",
    "seq -f '%05.2f' 1 3",
    "seq -f '%.0f' 0.5 1 3.5",
    "seq -f '%.1f' 0.25 0.5 1.75",
    "seq -f '%.1f' 0.05 0.1 0.35",
    "seq -f '%.1g' 0.5 1 3.5",
    "seq -f '%.1e' 0.25 0.5 1.75",
    "seq -f '%.0e' 2.5 1 4.5",
    "seq -f '%.2g' 0.125 0.001 0.127",
    "seq -f %g 1000000 1000001",
    "seq -f %g 999999 1000000",
    "seq -f %g 0.0001 0.00001 0.00012",
    "seq -f %g 0.00001 1",
    "seq -f %g -3 1 -1",
    "seq -f %e -0.001 1 0",
    "seq -f %e 0 1",
    "seq -f %.0e 0 1",
    "seq -f %#.0e 0 1",
    "seq -f %#.0f 1 2",
    "seq -f %.0f 1 2",
    "seq -f %.f 1 1",
    "seq -f %g 0 1",
    "seq -f %#g 0 1",
    "seq -f %#.1g 0 1",
    "seq -f %#g 1 2",
    "seq -f %10.3e 1 2",
    "seq -f %-8gX 1 2",
    "seq -f %-8g -1 1",
    "seq -f %+g 1 2",
    "seq -f %+8g 1 2",
    "seq -f '% g' 1 2",
    "seq -f '% 6g' -1 1",
    "seq -f %08.3f -1 1",
    "seq -f %1\\$g 1 2",
    "seq -f %lf 1 1",
    "seq -f %Lg 1 1",
    "seq -f x%gy 2",
    "seq -f '%%%g%%' 1 1",
    "seq -f 'a\\nb%g' 1 1",
    "seq -f %g 1e100 1e100",
    "seq -f %g -0 1",
    "seq -f %.3g 1234.5 1234.5",
    "seq -f %.3g 9995 9995",
  ])("formats: %j", async (source) => {
    await compare(source);
  });

  it.each([
    "seq",
    "seq 1 2 3 4",
    "seq abc",
    "seq 1e",
    "seq 1e+",
    "seq .",
    "seq '3 '",
    "seq '+ 3'",
    "seq 1_0",
    "seq 1e100000000000000000000",
    "seq nan",
    "seq 1 nan",
    "seq 1 0 3",
    "seq 1 -0 3",
    "seq 1 -0.0 2",
    "seq abc 0 1",
    "seq -x 2",
    "seq --foo 3",
    "seq -ws, 3",
    "seq 1 -w 3",
    "seq --3",
    "seq -s",
    "seq -f",
    "seq -s , -s ';' 3",
    "seq -w -w 2",
    "seq -f %g -f %g 2",
    "seq -w -f %g 2",
    "seq -f abc 2",
    "seq -f '%d' 2",
    "seq -f '%i' 2",
    "seq -f '%s' 2",
    "seq -f '%q' 2",
    "seq -f '%*g' 2",
    "seq -f '%.*g' 2",
    "seq -f '%g %g' 2",
    "seq -f '%g%' 2",
    "seq -f '%g%5%' 2",
    "seq -f '%5%' 2",
    "seq -f '%' 2",
    "seq -f 'x%' 2",
    "seq -f '%5' 2",
    "seq -f '%#d' 2",
    "seq -f '%0\\$g' 2",
    "seq -f %Z 2",
  ])("fails as uutils does: %j", async (source) => {
    await compare(source);
  });
});
