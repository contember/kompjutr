// Caller text that an operation journal stores verbatim. The store trusts its
// writers, so this boundary refuses what a journal TEXT column cannot hold.

import { GitError } from "../../common/errors.js";
import type { GitIdentity } from "../core/context.js";

export const MAX_JOURNAL_MESSAGE_BYTES = 1024 * 1024;
export const MAX_JOURNAL_IDENTITY_BYTES = 1_024;

function utf8Bytes(value: string, label: string, forbidden: (unit: number) => boolean): number {
  if (!value.isWellFormed()) throw new GitError("EINVAL", `${label} is not canonical UTF-16`);
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (forbidden(unit)) throw new GitError("EINVAL", `${label} contains an invalid character`);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      index++;
      bytes += 4;
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
  }
  return bytes;
}

function identityUnit(unit: number): boolean {
  return unit === 0 || unit === 0x0a || unit === 0x0d || unit === 0x3c || unit === 0x3e;
}

export function requireJournalMessage(message: string, operation: string): void {
  const bytes = utf8Bytes(message, `${operation} message`, (unit) => unit === 0);
  if (bytes > MAX_JOURNAL_MESSAGE_BYTES) {
    throw new GitError(
      "E2BIG",
      `${operation} message exceeds ${MAX_JOURNAL_MESSAGE_BYTES} UTF-8 bytes`,
    );
  }
}

function requireIdentityText(value: string, label: string): void {
  const bytes = utf8Bytes(value, label, identityUnit);
  if (bytes === 0) throw new GitError("EINVAL", `${label} is empty`);
  if (bytes > MAX_JOURNAL_IDENTITY_BYTES) {
    throw new GitError("E2BIG", `${label} exceeds ${MAX_JOURNAL_IDENTITY_BYTES} UTF-8 bytes`);
  }
}

export function requireJournalIdentity(
  identity: GitIdentity | undefined,
  label: string,
  operation: string,
): void {
  if (identity === undefined) return;
  requireIdentityText(identity.name, `${operation} ${label} name`);
  requireIdentityText(identity.email, `${operation} ${label} email`);
}
