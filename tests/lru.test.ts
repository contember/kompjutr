import { describe, expect, it } from "vitest";

import { ByteLru } from "../packages/git/src/common/lru.js";

describe("ByteLru", () => {
  it("bounds zero-payload entries by their fixed retained cost", () => {
    const cache = new ByteLru<number, number>(1024, (bytes) => bytes);
    for (let key = 0; key < 100; key++) cache.set(key, 0);
    expect(cache.size).toBe(4);
    expect(cache.bytes).toBe(1024);
    expect(cache.has(95)).toBe(false);
    expect(cache.has(96)).toBe(true);
  });

  it("preserves exact quarter-budget admission and failed-set state", () => {
    const budget = 8 * 1024 * 1024;
    const cache = new ByteLru<string, number>(budget, (bytes) => bytes);
    cache.set("exact", budget / 4);
    expect(cache.get("exact")).toBe(budget / 4);
    expect(cache.bytes).toBe(budget / 4);
    cache.set("too-large", budget / 4 + 1);
    expect(cache.has("too-large")).toBe(false);
    expect(cache.bytes).toBe(budget / 4);
  });

  it("rejects invalid budgets and entry sizes before mutation", () => {
    expect(() => new ByteLru(-1, () => 0)).toThrow(/budget/);
    const cache = new ByteLru<string, number>(1024, (bytes) => bytes);
    cache.set("valid", 1);
    expect(() => cache.set("invalid", Number.NaN)).toThrow(/entry size/);
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(256);
  });
});
