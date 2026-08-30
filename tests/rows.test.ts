import { describe, expect, it } from "vitest";
import {
  array,
  blob,
  bool,
  decodeRow,
  expectBlob,
  expectNullable,
  expectSafeInteger,
  expectText,
  int,
  nullable,
  OptionsSchema,
  optional,
  RowShape,
  text,
} from "../src/core/rows.js";

function expectCorrupt(action: () => unknown, message: string): void {
  expect(action).toThrowError(expect.objectContaining({ code: "ECORRUPT", message }));
}

describe("stored value guards", () => {
  it("decodes text, bounded safe integers, blobs, and nullable values", () => {
    const bytes = new Uint8Array([1, 2, 3]);

    expect(expectText("name", "name")).toBe("name");
    expect(expectSafeInteger(2, 1, 3, "ordinal")).toBe(2);
    expect(expectBlob(bytes, "payload")).toBe(bytes);
    expect(expectNullable(null, (value) => expectText(value, "cursor"))).toBeNull();
    expect(expectNullable("next", (value) => expectText(value, "cursor"))).toBe("next");
  });

  it("reports primitive type and range failures as corruption", () => {
    expectCorrupt(() => expectText(1, "name"), "name is not text");
    expectCorrupt(
      () => expectSafeInteger(4, 1, 3, "ordinal"),
      "ordinal is not a bounded safe integer",
    );
    expectCorrupt(
      () => expectSafeInteger(1.5, 1, 3, "ordinal"),
      "ordinal is not a bounded safe integer",
    );
    expectCorrupt(() => expectBlob(new ArrayBuffer(1), "payload"), "payload is not a blob");
  });
});

describe("row shapes", () => {
  const shape = {
    name: text("row name is not text"),
    ordinal: int(1, 3, "row ordinal is out of range"),
    payload: blob("row payload is not a blob"),
    parent: nullable(text("row parent is not text")),
  };

  it("decodes one declaration into a typed row", () => {
    const payload = new Uint8Array([7]);

    expect(decodeRow({ name: "entry", ordinal: 2, payload, parent: null }, shape)).toEqual({
      name: "entry",
      ordinal: 2,
      payload,
      parent: null,
    });
    expect(
      new RowShape(shape).decode({ name: "entry", ordinal: 1, payload, parent: "root" }),
    ).toEqual({ name: "entry", ordinal: 1, payload, parent: "root" });
  });

  it("rejects a non-row, wrong field type, out-of-range integer, and forbidden null", () => {
    const payload = new Uint8Array([7]);

    expectCorrupt(() => decodeRow(null, shape, "row is malformed"), "row is malformed");
    expectCorrupt(
      () => decodeRow({ name: 1, ordinal: 2, payload, parent: null }, shape),
      "row name is not text",
    );
    expectCorrupt(
      () => decodeRow({ name: "entry", ordinal: 4, payload, parent: null }, shape),
      "row ordinal is out of range",
    );
    expectCorrupt(
      () => decodeRow({ name: null, ordinal: 2, payload, parent: null }, shape),
      "row name is not text",
    );
  });
});

describe("caller option schemas", () => {
  const schema = new OptionsSchema(
    {
      enabled: optional(bool("demo enabled must be a boolean")),
      roots: optional(array(text("demo roots must be strings"), "demo roots must be an array")),
    },
    "demo options must be an object",
  );

  it("returns one typed options value", () => {
    expect(schema.decode({ enabled: true, roots: ["a", "b"] })).toEqual({
      enabled: true,
      roots: ["a", "b"],
    });
    expect(schema.decode({})).toEqual({ enabled: undefined, roots: undefined });
  });

  it("preserves declared GitError codes and messages", () => {
    expect(() => schema.decode(null)).toThrowError(
      expect.objectContaining({ code: "EINVAL", message: "demo options must be an object" }),
    );
    expect(() => schema.decode({ enabled: "yes" })).toThrowError(
      expect.objectContaining({ code: "EINVAL", message: "demo enabled must be a boolean" }),
    );
    expect(() => schema.decode({ roots: "a" })).toThrowError(
      expect.objectContaining({ code: "EINVAL", message: "demo roots must be an array" }),
    );
    expect(() => schema.decode({ roots: ["a", 1] })).toThrowError(
      expect.objectContaining({ code: "EINVAL", message: "demo roots must be strings" }),
    );
  });
});
