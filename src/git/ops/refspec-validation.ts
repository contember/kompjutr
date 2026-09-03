import { GitError } from "../common/errors.js";
import { checkRefText, hasCanonicalRefSyntax } from "../common/ref-name.js";

export function malformed(message: string): GitError {
  return new GitError("EINVAL", message);
}

export function invalidRef(label: string): GitError {
  return new GitError("EINVALIDREF", `${label} is not a canonical full ref`);
}

export function canonicalRefText(value: string, label: string): void {
  const checked = checkRefText(value);
  if (checked.problem !== null) throw invalidRef(label);
}

export function requireFullRef(value: string, label: string): void {
  canonicalRefText(value, label);
  if (!value.startsWith("refs/") || !hasCanonicalRefSyntax(value)) throw invalidRef(label);
}
