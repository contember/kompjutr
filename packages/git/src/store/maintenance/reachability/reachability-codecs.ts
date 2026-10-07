import { isOid } from "../../../common/bytes.js";
import { CorruptError } from "../../../common/errors.js";
import type { ObjectType } from "../../../common/objects.js";
import type { ReachabilityEdge } from "./reachability-contracts.js";

export function booleanInteger(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) throw new CorruptError(`${label} is not boolean`);
  return value === 1;
}

export function objectType(value: unknown, label: string): ObjectType {
  if (value !== "blob" && value !== "tree" && value !== "commit" && value !== "tag") {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

export function oidField(value: unknown, label: string): string {
  if (typeof value !== "string" || !isOid(value)) {
    throw new CorruptError(`${label} is invalid`);
  }
  return value;
}

export function bytesField(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new CorruptError(`${label} is not a BLOB`);
}

/** One tree entry as a reachability edge; projections and raw tree objects share it. */
export function treeModeEdge(mode: unknown, oid: string): ReachabilityEdge {
  if (
    mode !== "40000" &&
    mode !== "040000" &&
    mode !== "100644" &&
    mode !== "100755" &&
    mode !== "120000" &&
    mode !== "160000"
  ) {
    throw new CorruptError("tree edge mode is invalid");
  }
  const type =
    mode === "40000" || mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob";
  return {
    oid,
    type,
    optionalMissing: mode === "160000",
    allowPromisedMissing: type === "blob",
  };
}
