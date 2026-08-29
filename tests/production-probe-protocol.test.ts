import { describe, expect, it } from "vitest";

import { probeSuccess } from "../bench/production/protocol.js";

const valid = {
  ok: true,
  action: "meta",
  instanceId: "instance",
  constructorOrdinal: 1,
  foreignKeysBefore: 0,
  foreignKeysAfter: 1,
  databaseBytes: 4096,
  metrics: { statements: 2, rows: 3, statementTarget: "pass" },
  facts: {},
};

describe("production probe protocol", () => {
  it("accepts the complete success envelope", () => {
    expect(probeSuccess(valid)).toEqual(valid);
  });

  it.each([
    [1_000, "pass"],
    [1_001, "miss"],
  ])("reports statement target status at %i statements as %s", (statements, statementTarget) => {
    const missed = {
      ...valid,
      metrics: { statements, rows: 3, statementTarget },
    };
    expect(probeSuccess(missed)).toEqual(missed);
  });

  it.each([
    null,
    {},
    { ...valid, ok: false },
    { ...valid, constructorOrdinal: -1 },
    { ...valid, metrics: { statements: 1.5, rows: 3, statementTarget: "pass" } },
    { ...valid, metrics: { statements: 1_001, rows: 3, statementTarget: "pass" } },
  ])("rejects malformed envelopes", (value) => {
    expect(() => probeSuccess(value)).toThrow();
  });
});
