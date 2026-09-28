import { jsonStringEncodedBytes } from "@kompjutr/sqlite";
import { expect, it } from "vitest";

const encoder = new TextEncoder();

function stringifiedBytes(value: string): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function units(...codes: number[]): string {
  return String.fromCharCode(...codes);
}

it("counts the bytes of JSON.stringify for escapes, controls, and surrogates", () => {
  const cases = [
    "",
    "plain/ascii.txt",
    '"',
    "\\",
    'a"b\\c',
    "\b\t\n\f\r",
    units(0x00, 0x01, 0x1f),
    units(0x7f),
    units(0x80, 0x7ff),
    units(0x800, 0xffff),
    units(0x2028, 0x2029),
    units(0xd83d, 0xde00),
    `a${units(0xdbff, 0xdfff)}b`,
    units(0xd800),
    units(0xdfff),
    units(0xdc00, 0xd800),
    `x${units(0xd83d)}y`,
    units(0xd83d, 0xd83d, 0xde00),
    `/dir/${units(0xe9)}t/${units(0xd83d, 0xdcc1)}/${units(0x2028)}\n"q"`,
  ];
  for (const value of cases) {
    expect(jsonStringEncodedBytes(value), JSON.stringify(value)).toBe(stringifiedBytes(value));
  }
});

it("matches JSON.stringify over seeded random UTF-16 strings", () => {
  let state = 0x2545f491;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  // Weight the edges: controls, escapes, both surrogate halves, and the BMP top.
  const pools: ReadonlyArray<readonly [number, number]> = [
    [0x00, 0x20],
    [0x20, 0x80],
    [0x80, 0x800],
    [0x800, 0xd800],
    [0xd800, 0xdc00],
    [0xdc00, 0xe000],
    [0xe000, 0x10000],
  ];
  for (let round = 0; round < 5_000; round++) {
    const codes: number[] = [];
    const length = next() % 24;
    for (let index = 0; index < length; index++) {
      const pool = pools[next() % pools.length];
      if (pool === undefined) throw new Error("pool index out of range");
      codes.push(pool[0] + (next() % (pool[1] - pool[0])));
    }
    const value = units(...codes);
    expect(jsonStringEncodedBytes(value), JSON.stringify(value)).toBe(stringifiedBytes(value));
  }
});
