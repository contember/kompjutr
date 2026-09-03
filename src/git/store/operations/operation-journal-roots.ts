import type { SqlDatabase } from "../../../db/db.js";
import { CorruptError, GitError } from "../../common/errors.js";
import type { ExpectedOperationObject, OperationRootPage } from "./operation-journal-types.js";
import { requireMergeOid } from "./operations.js";

interface OperationRootRow {
  oid: unknown;
  expected_type: unknown;
}

export function operationRootPage(
  db: SqlDatabase,
  checkoutId: number,
  cursor = 0,
  limit = 128,
): OperationRootPage {
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new GitError("EINVAL", "operation root cursor must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
    throw new GitError("EINVAL", "operation root page limit must be between 1 and 256");
  }
  const roots: ExpectedOperationObject[] = [];
  for (const raw of db.iterate(
    `SELECT oid, expected_type FROM (
       SELECT original_head_oid AS oid, 'commit' AS expected_type, 0 AS family, 0 AS ordinal
         FROM git_operation_state WHERE checkout_id = ?
       UNION ALL
       SELECT current_parent_oid, 'commit', 0, 1 FROM git_operation_state
         WHERE checkout_id = ? AND current_parent_oid IS NOT NULL
       UNION ALL
       SELECT incoming_parent_oid, 'commit', 0, 2 FROM git_operation_state
         WHERE checkout_id = ? AND incoming_parent_oid IS NOT NULL
       UNION ALL
       SELECT upstream_oid, 'commit', 0, 3 FROM git_operation_state
         WHERE checkout_id = ? AND upstream_oid IS NOT NULL
       UNION ALL
       SELECT base_oid, 'commit', 0, 4 FROM git_operation_state
         WHERE checkout_id = ? AND base_oid IS NOT NULL
       UNION ALL
       SELECT source_oid, 'commit', 1, ordinal * 3 FROM git_operation_steps
         WHERE checkout_id = ?
       UNION ALL
       SELECT selected_parent_oid, 'commit', 1, ordinal * 3 + 1 FROM git_operation_steps
         WHERE checkout_id = ? AND selected_parent_oid IS NOT NULL
       UNION ALL
       SELECT result_oid, 'commit', 1, ordinal * 3 + 2 FROM git_operation_steps
         WHERE checkout_id = ? AND result_oid IS NOT NULL
       UNION ALL
       SELECT index_oid, CASE WHEN index_mode = 57344 THEN 'commit' ELSE 'blob' END,
              2, ordinal * 2
         FROM git_operation_touched WHERE checkout_id = ? AND index_oid IS NOT NULL
       UNION ALL
       SELECT worktree_oid, 'blob', 2, ordinal * 2 + 1 FROM git_operation_touched
         WHERE checkout_id = ? AND worktree_oid IS NOT NULL
     ) ORDER BY family, ordinal LIMIT ? OFFSET ?`,
    checkoutId,
    checkoutId,
    checkoutId,
    checkoutId,
    checkoutId,
    checkoutId,
    checkoutId,
    checkoutId,
    checkoutId,
    checkoutId,
    limit + 1,
    cursor,
  )) {
    const row: OperationRootRow = { oid: raw.oid, expected_type: raw.expected_type };
    if (roots.length === limit) {
      return { roots, nextCursor: cursor + limit };
    }
    const type = row.expected_type;
    if (type !== "blob" && type !== "commit") {
      throw new CorruptError("operation root has an invalid expected type");
    }
    roots.push({
      oid: requireMergeOid(row.oid, "operation root"),
      type,
      label: "operation root",
    });
  }
  return { roots, nextCursor: null };
}
