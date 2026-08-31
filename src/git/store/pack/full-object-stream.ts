import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError, ObjectNotFoundError } from "../../common/errors.js";
import type { ObjectType, RawObject } from "../../common/objects.js";
import { PackWriter } from "./writer.js";

export const MAX_FULL_OBJECT_PACK_OBJECTS = 100_000;
const OBJECT_PAGE = 4_096;
const DEFLATE_INPUT = 16 * 1024;

function isObjectType(value: string): value is ObjectType {
  return value === "blob" || value === "tree" || value === "commit" || value === "tag";
}

export interface FullObjectPackInput {
  oid: string;
  type: ObjectType;
  size: number;
}

export interface FullObjectPackReader {
  readBatch(objects: readonly FullObjectPackInput[]): ReadonlyMap<string, RawObject>;
  readChunks(object: FullObjectPackInput): Iterable<Uint8Array> | null;
}

export interface FullObjectPackOptions {
  maxObjects: number;
  maxInflatedBytes: number;
  maxStoredBytes: number;
  readBatchBytes: number;
  /** Stream objects above the read limit; only a single one may exceed the inflated limit. */
  allowOversizedObject?: boolean;
}

function drainReady(ready: Uint8Array[]): Uint8Array[] {
  const chunks = ready.slice();
  ready.length = 0;
  return chunks;
}

function* inputSlices(bytes: Uint8Array): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += DEFLATE_INPUT) {
    yield bytes.subarray(offset, offset + DEFLATE_INPUT);
  }
}

function requireLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function validatePlan(
  objects: readonly FullObjectPackInput[],
  options: FullObjectPackOptions,
): void {
  requireLimit(options.maxObjects, "full-object pack object limit");
  requireLimit(options.maxInflatedBytes, "full-object pack inflated-byte limit");
  requireLimit(options.maxStoredBytes, "full-object pack stored-byte limit");
  requireLimit(options.readBatchBytes, "full-object pack read-batch limit");
  if (options.maxObjects > MAX_FULL_OBJECT_PACK_OBJECTS || objects.length > options.maxObjects) {
    throw new GitError("E2BIG", `full-object pack exceeds ${options.maxObjects} objects`);
  }
  const seen = new Set<string>();
  let inflatedBytes = 0;
  for (const object of objects) {
    if (
      !isOid(object.oid) ||
      !isObjectType(object.type) ||
      !Number.isSafeInteger(object.size) ||
      object.size < 0 ||
      seen.has(object.oid)
    ) {
      throw new CorruptError("full-object pack plan is invalid");
    }
    seen.add(object.oid);
    if (object.size > Number.MAX_SAFE_INTEGER - inflatedBytes) {
      throw new GitError("E2BIG", "full-object pack inflated size is not representable");
    }
    inflatedBytes += object.size;
  }
  if (
    inflatedBytes > options.maxInflatedBytes &&
    !(
      options.allowOversizedObject === true &&
      objects.length === 1 &&
      objects[0] !== undefined &&
      objects[0].size > options.maxInflatedBytes
    )
  ) {
    throw new GitError(
      "E2BIG",
      `full-object pack exceeds ${options.maxInflatedBytes} inflated bytes`,
    );
  }
}

function* writeChunkedObject(
  writer: PackWriter,
  object: FullObjectPackInput,
  chunks: Iterable<Uint8Array> | null,
  ready: Uint8Array[],
): Generator<Uint8Array> {
  if (chunks === null) throw new ObjectNotFoundError(object.oid);
  const entry = writer.startObject(object.type, object.size, object.oid);
  yield* drainReady(ready);
  for (const chunk of chunks) {
    for (const slice of inputSlices(chunk)) {
      entry.push(slice);
      yield* drainReady(ready);
    }
  }
  entry.finish();
  yield* drainReady(ready);
}

/** Generate a bounded full-object pack without retaining the pack bytes. */
export async function* streamFullObjectPack(
  objects: readonly FullObjectPackInput[],
  reader: FullObjectPackReader,
  options: FullObjectPackOptions,
): AsyncGenerator<Uint8Array> {
  validatePlan(objects, options);
  const ready: Uint8Array[] = [];
  let storedBytes = 0;
  const writer = new PackWriter((chunk) => {
    if (chunk.length > options.maxStoredBytes - storedBytes) {
      throw new GitError(
        "E2BIG",
        `full-object pack exceeds ${options.maxStoredBytes} stored bytes`,
      );
    }
    storedBytes += chunk.length;
    ready.push(chunk);
  });
  writer.header(objects.length);
  yield* drainReady(ready);

  let at = 0;
  while (at < objects.length) {
    const first = objects[at];
    if (first === undefined) throw new CorruptError("full-object pack made no progress");
    if (first.size > options.readBatchBytes) {
      if (options.allowOversizedObject !== true) {
        throw new GitError(
          "E2BIG",
          `full-object pack object ${first.oid} exceeds the ${options.readBatchBytes} byte read limit`,
        );
      }
      yield* writeChunkedObject(writer, first, reader.readChunks(first), ready);
      at++;
      continue;
    }

    let pageBytes = 0;
    let end = at;
    while (end < objects.length && end - at < OBJECT_PAGE) {
      const object = objects[end];
      if (object === undefined || object.size > options.readBatchBytes - pageBytes) break;
      pageBytes += object.size;
      end++;
    }
    const page = objects.slice(at, end);
    const batch = reader.readBatch(page);
    if (batch.size === 0 || batch.size > page.length) {
      throw new CorruptError("full-object pack batch made invalid progress");
    }
    for (const [oid, raw] of batch) {
      const object = objects[at];
      if (
        object === undefined ||
        object.oid !== oid ||
        object.type !== raw.type ||
        object.size !== raw.data.length
      ) {
        throw new CorruptError("full-object pack batch returned objects out of plan order");
      }
      const entry = writer.startObject(raw.type, raw.data.length, oid);
      yield* drainReady(ready);
      for (const slice of inputSlices(raw.data)) {
        entry.push(slice);
        yield* drainReady(ready);
      }
      entry.finish();
      yield* drainReady(ready);
      at++;
    }
  }
  writer.finish();
  yield* drainReady(ready);
}
