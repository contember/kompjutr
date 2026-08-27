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
  metrics: { statements: 2, rows: 3 },
  facts: {},
};

describe("production probe protocol", () => {
  it("accepts the complete success envelope", () => {
    expect(probeSuccess(valid)).toEqual(valid);
  });

  it.each([
    null,
    {},
    { ...valid, ok: false },
    { ...valid, constructorOrdinal: -1 },
    { ...valid, metrics: { statements: 1.5, rows: 3 } },
  ])("rejects malformed envelopes", (value) => {
    expect(() => probeSuccess(value)).toThrow();
  });
});
