import { isOid } from "../core/bytes.js";
import { CorruptError, GitError } from "../core/errors.js";
import { checkRefText, hasCanonicalRefSyntax } from "../core/ref-name.js";

export type RefValueSource = "input" | "stored";

function invalidRefValue(source: RefValueSource, message: string): never {
  if (source === "stored") throw new CorruptError(message);
  throw new GitError("EINVAL", message);
}

export function refTextBytes(value: string, label: string, source: RefValueSource): number {
  const checked = checkRefText(value);
  if (checked.problem === "invalid-character") {
    invalidRefValue(source, `${label} contains an invalid character`);
  }
  if (checked.problem === "noncanonical-utf16") {
    invalidRefValue(source, `${label} is not canonical UTF-16`);
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
  refTextBytes(value, label, source);
  if (!hasCanonicalRefSyntax(value)) invalidRefValue(source, `${label} is invalid`);
  return value;
}

export function rawSymbolicTarget(value: string): string | null {
  return hasRawSymbolicTarget(value) ? value.slice(5) : null;
}

function hasRawSymbolicTarget(value: string): boolean {
  return (
    value.startsWith("ref: ") &&
    value.length > 5 &&
    !(value.length === 9 && value.endsWith("HEAD")) &&
    hasCanonicalRefSyntax(value, 5)
  );
}

export function requireRawRefTarget(value: unknown, label: string, source: RefValueSource): string {
  if (typeof value !== "string" || value === "") invalidRefValue(source, `${label} is invalid`);
  refTextBytes(value, label, source);
  if (isOid(value)) return value;
  if (!hasRawSymbolicTarget(value)) {
    invalidRefValue(source, `${label} is not an OID or symbolic ref`);
  }
  return value;
}
