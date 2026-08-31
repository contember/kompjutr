import { CorruptError, GitError } from "./errors.js";

interface DecodeSuccess<T> {
  ok: true;
  value: T;
}

interface DecodeFailure {
  ok: false;
  message: string;
}

type DecodeResult<T> = DecodeSuccess<T> | DecodeFailure;

type DecoderShape = Record<string, Decoder<unknown>>;

export type DecodedShape<Shape extends DecoderShape> = {
  [Key in keyof Shape]: Shape[Key] extends Decoder<infer Value> ? Value : never;
};

function success<T>(value: T): DecodeSuccess<T> {
  return { ok: true, value };
}

function failure(message: string): DecodeFailure {
  return { ok: false, message };
}

function decodeObject<const Shape extends DecoderShape>(
  value: unknown,
  shape: Shape,
  objectMessage: string,
): DecodeResult<DecodedShape<Shape>>;
function decodeObject(
  value: unknown,
  shape: DecoderShape,
  objectMessage: string,
): DecodeResult<unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure(objectMessage);
  }
  const decoded: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    const decoder = shape[key];
    if (decoder === undefined) return failure(objectMessage);
    const field = decoder.tryDecode(Reflect.get(value, key));
    if (!field.ok) return field;
    decoded[key] = field.value;
  }
  return success(decoded);
}

/** A reusable value declaration shared by row and caller-option schemas. */
export class Decoder<T> {
  readonly #decode: (value: unknown) => DecodeResult<T>;

  constructor(decode: (value: unknown) => DecodeResult<T>) {
    this.#decode = decode;
  }

  tryDecode(value: unknown): DecodeResult<T> {
    return this.#decode(value);
  }

  where(predicate: (value: T) => boolean, message: string): Decoder<T> {
    return new Decoder((value) => {
      const decoded = this.tryDecode(value);
      if (!decoded.ok || predicate(decoded.value)) return decoded;
      return failure(message);
    });
  }
}

/** A stored-row declaration whose failures are always corruption errors. */
export class RowShape<Shape extends DecoderShape> {
  readonly #shape: Shape;
  readonly #objectMessage: string;

  constructor(shape: Shape, objectMessage = "stored row is malformed") {
    this.#shape = shape;
    this.#objectMessage = objectMessage;
  }

  decode(row: unknown): DecodedShape<Shape> {
    const decoded = decodeObject(row, this.#shape, this.#objectMessage);
    if (!decoded.ok) throw new CorruptError(decoded.message);
    return decoded.value;
  }
}

/** A caller-options declaration whose failures retain one public Git error code. */
export class OptionsSchema<Shape extends DecoderShape> {
  readonly #shape: Shape;
  readonly #objectMessage: string;
  readonly #code: string;

  constructor(shape: Shape, objectMessage: string, code = "EINVAL") {
    this.#shape = shape;
    this.#objectMessage = objectMessage;
    this.#code = code;
  }

  decode(options: unknown): DecodedShape<Shape> {
    const decoded = decodeObject(options, this.#shape, this.#objectMessage);
    if (!decoded.ok) throw new GitError(this.#code, decoded.message);
    return decoded.value;
  }
}

export function decodeRow<const Shape extends DecoderShape>(
  row: unknown,
  shape: Shape,
  objectMessage = "stored row is malformed",
): DecodedShape<Shape> {
  return new RowShape(shape, objectMessage).decode(row);
}

export function expectText(value: unknown, label = "stored value"): string {
  if (typeof value !== "string") throw new CorruptError(`${label} is not text`);
  return value;
}

export function expectSafeInteger(
  value: unknown,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
  label = "stored value",
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new CorruptError(`${label} is not a bounded safe integer`);
  }
  return value;
}

export function expectBlob(value: unknown, label = "stored value"): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new CorruptError(`${label} is not a blob`);
  return value;
}

export function expectNullable<T>(
  value: unknown,
  expectValue: (candidate: unknown) => T,
): T | null {
  return value === null ? null : expectValue(value);
}

export function text(message = "stored value is not text"): Decoder<string> {
  return new Decoder((value) => (typeof value === "string" ? success(value) : failure(message)));
}

export function number(message = "stored value is not a number"): Decoder<number> {
  return new Decoder((value) => (typeof value === "number" ? success(value) : failure(message)));
}

export function int(
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
  message = "stored value is not a bounded safe integer",
): Decoder<number> {
  return new Decoder((value) => {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      return failure(message);
    }
    return success(value);
  });
}

export function blob(message = "stored value is not a blob"): Decoder<Uint8Array> {
  return new Decoder((value) => (value instanceof Uint8Array ? success(value) : failure(message)));
}

export function bool(message = "stored value is not a boolean"): Decoder<boolean> {
  return new Decoder((value) => (typeof value === "boolean" ? success(value) : failure(message)));
}

export function nullable<T>(decoder: Decoder<T>): Decoder<T | null> {
  return new Decoder((value) => (value === null ? success(null) : decoder.tryDecode(value)));
}

export function optional<T>(decoder: Decoder<T>): Decoder<T | undefined> {
  return new Decoder((value) =>
    value === undefined ? success(undefined) : decoder.tryDecode(value),
  );
}

export function array<T>(
  decoder: Decoder<T>,
  message = "stored value is not an array",
): Decoder<T[]> {
  return new Decoder((value) => {
    if (!Array.isArray(value)) return failure(message);
    const decoded: T[] = [];
    for (let index = 0; index < value.length; index++) {
      const item = decoder.tryDecode(Reflect.get(value, index));
      if (!item.ok) return item;
      decoded.push(item.value);
    }
    return success(decoded);
  });
}

export function unknownArray(message = "stored value is not an array"): Decoder<unknown[]> {
  return new Decoder((value) => (Array.isArray(value) ? success(value) : failure(message)));
}

export function unknownValue(): Decoder<unknown> {
  return new Decoder((value) => success(value));
}

export function object<const Shape extends DecoderShape>(
  shape: Shape,
  message = "stored value is not an object",
): Decoder<DecodedShape<Shape>> {
  return new Decoder((value) => decodeObject(value, shape, message));
}

type Literal = string | number | boolean | null;

function containsLiteral<Value extends Literal>(
  values: readonly Value[],
  candidate: Literal,
): candidate is Value {
  for (const value of values) {
    if (value === candidate) return true;
  }
  return false;
}

export function oneOf<const Values extends readonly Literal[]>(
  values: Values,
  message = "stored value is invalid",
): Decoder<Values[number]> {
  return new Decoder((value) => {
    if (
      (typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null) &&
      containsLiteral(values, value)
    ) {
      return success(value);
    }
    return failure(message);
  });
}
