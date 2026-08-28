import { isOid } from "../core/bytes.js";
import { CorruptError, GitError } from "../core/errors.js";
import { checkRefText, hasCanonicalRefSyntax } from "../core/ref-name.js";
import { MAX_REFLOG_RAW_TARGET_BYTES, MAX_REFLOG_REF_BYTES } from "./reflog-schema.js";

export type RefValueSource = "input" | "stored";

function invalidRefValue(source: RefValueSource, message: string): never {
  if (source === "stored") throw new CorruptError(message);
  throw new GitError("EINVAL", message);
}

export function boundedRefText(
  value: string,
  label: string,
  limit: number,
  source: RefValueSource,
): number {
  const checked = checkRefText(value, limit);
  if (checked.problem === "invalid-character") {
    invalidRefValue(source, `${label} contains an invalid character`);
  }
  if (checked.problem === "noncanonical-utf16") {
    invalidRefValue(source, `${label} is not canonical UTF-16`);
  }
  if (checked.problem === "too-long") {
    if (source === "stored") throw new CorruptError(`${label} exceeds its stored byte bound`);
    throw new GitError("E2BIG", `${label} exceeds ${limit} UTF-8 bytes`);
  }
  return checked.bytes;
}

export function requireRefName(
  value: unknown,
  label: string,
  source: RefValueSource,
  allowHead = false,
): string {
  if (typeof value !== "string" || value === "" || (!allowHead && value === "HEAD")) {
    invalidRefValue(source, `${label} is invalid`);
  }
  boundedRefText(value, label, MAX_REFLOG_REF_BYTES, source);
  if (!hasCanonicalRefSyntax(value)) invalidRefValue(source, `${label} is invalid`);
  return value;
}

export function rawSymbolicTarget(value: string): string | null {
  if (!value.startsWith("ref: ")) return null;
  const target = value.slice(5);
  if (target === "" || target === "HEAD" || target.startsWith("ref: ")) return null;
  return target;
}

export function requireRawRefTarget(value: unknown, label: string, source: RefValueSource): string {
  if (typeof value !== "string" || value === "") invalidRefValue(source, `${label} is invalid`);
  boundedRefText(value, label, MAX_REFLOG_RAW_TARGET_BYTES, source);
  if (isOid(value)) return value;
  const symbolic = rawSymbolicTarget(value);
  if (symbolic === null) invalidRefValue(source, `${label} is not an OID or symbolic ref`);
  requireRefName(symbolic, `${label} symbolic ref`, source);
  return value;
}
