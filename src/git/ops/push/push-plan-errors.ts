import { GitError, hasErrorCode } from "../../common/errors.js";

export function localPushError(error: unknown): never {
  if (
    hasErrorCode(error, "E2BIG") ||
    hasErrorCode(error, "EINVAL") ||
    hasErrorCode(error, "EINVALIDREF") ||
    hasErrorCode(error, "ENONFASTFORWARD") ||
    hasErrorCode(error, "ETAGFAIL")
  ) {
    throw error;
  }
  throw new GitError("EPUSHLOCAL", "local push source or closure is incomplete", { cause: error });
}
