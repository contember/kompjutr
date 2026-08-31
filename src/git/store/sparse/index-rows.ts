import { isOid } from "../../common/bytes.js";
import { CorruptError } from "../../common/errors.js";
import type { IndexEntry } from "../index.js";
import { parseRelativePath } from "./shared.js";
import { numberField } from "./tree-resolution.js";

export function validStoredIndexPath(path: string, bytes: number): boolean {
  try {
    return parseRelativePath(path).bytes === bytes;
  } catch {
    return false;
  }
}

export function validatedSparseIndexEntry(row: Record<string, unknown>): IndexEntry {
  const path = row.path;
  const pathBytes = numberField(row.path_bytes);
  const stage = numberField(row.stage);
  const mode = numberField(row.mode);
  const oid = row.oid;
  const size = numberField(row.size);
  const mtime = numberField(row.mtime);
  const ino = numberField(row.ino);
  const rev = numberField(row.rev);
  if (
    row.path_type !== "text" ||
    typeof path !== "string" ||
    pathBytes === null ||
    pathBytes < 0 ||
    !validStoredIndexPath(path, pathBytes) ||
    row.stage_type !== "integer" ||
    stage === null ||
    stage < 0 ||
    stage > 3 ||
    row.mode_type !== "integer" ||
    mode === null ||
    ![0o100644, 0o100755, 0o120000, 0o160000].includes(mode) ||
    row.oid_type !== "text" ||
    typeof oid !== "string" ||
    !isOid(oid) ||
    !["null", "integer"].includes(typeof row.size_type === "string" ? row.size_type : "") ||
    !["null", "integer"].includes(typeof row.mtime_type === "string" ? row.mtime_type : "") ||
    !["null", "integer"].includes(typeof row.ino_type === "string" ? row.ino_type : "") ||
    !["null", "integer"].includes(typeof row.rev_type === "string" ? row.rev_type : "") ||
    (row.size !== null && size === null) ||
    (row.mtime !== null && mtime === null) ||
    (row.ino !== null && ino === null) ||
    (row.rev !== null && rev === null) ||
    (size !== null && size < 0) ||
    (ino !== null && ino <= 0) ||
    (rev !== null && rev < 0)
  ) {
    throw new CorruptError("sparse index lookup returned a malformed row");
  }
  return { path, stage, mode, oid, size, mtime, ino, rev };
}
