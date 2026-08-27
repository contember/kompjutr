import { isOid } from "../core/bytes.js";
import { CorruptError, GitError } from "../core/errors.js";
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
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0 || unit === 0x0a || unit === 0x0d) {
      invalidRefValue(source, `${label} contains an invalid character`);
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) invalidRefValue(source, `${label} is not canonical UTF-16`);
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      invalidRefValue(source, `${label} is not canonical UTF-16`);
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (bytes > limit) {
      if (source === "stored") throw new CorruptError(`${label} exceeds its stored byte bound`);
      throw new GitError("E2BIG", `${label} exceeds ${limit} UTF-8 bytes`);
    }
  }
  return bytes;
}

function hasInvalidRefSyntax(value: string): boolean {
  if (
    value === "@" ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{")
  )
    return true;
  for (const component of value.split("/")) {
    if (component.startsWith(".") || component.endsWith(".lock")) return true;
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || " ~^:?*[\\".includes(value[index] ?? "")) return true;
  }
  return false;
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
  if (hasInvalidRefSyntax(value)) invalidRefValue(source, `${label} is invalid`);
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
