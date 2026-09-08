import type { SqlDatabase } from "../../db/db.js";
import { filesystemError as fsError } from "../errors.js";
import { codePointLength, dirname, subtreeSuccessor } from "../path.js";
import type { RealPath } from "../types.js";

interface RenameRow {
  source_inode: number | null;
  target_inode: number | null;
  target_child: number;
}

const BUMP_REV = "UPDATE fs_meta SET v = v + 1 WHERE k = 'rev'";

const RENAME_SUBTREE = `UPDATE fs_paths
   SET path   = ? || substr(path, ? + 1),
       parent = CASE WHEN parent = ? THEN ?
                     ELSE ? || substr(parent, ? + 1) END
 WHERE path >= ? || '/' AND path < ?`;

/** Move a validated path, replacing a validated file or empty directory. */
export function renameRaw(db: SqlDatabase, oldPath: RealPath, newPath: RealPath): void {
  if (oldPath === newPath) return;
  const oldLength = codePointLength(oldPath);
  db.transactionSync(() => {
    const classified = db.one<RenameRow>(
      `SELECT (SELECT inode FROM fs_paths WHERE path = ?) AS source_inode,
              (SELECT inode FROM fs_paths WHERE path = ?) AS target_inode,
              EXISTS (SELECT 1 FROM fs_paths
                       WHERE path >= ? || '/' AND path < ?) AS target_child`,
      oldPath,
      newPath,
      newPath,
      subtreeSuccessor(newPath),
    );
    if (
      classified !== undefined &&
      classified.source_inode !== null &&
      classified.source_inode === classified.target_inode
    ) {
      db.run(BUMP_REV);
      db.run("DELETE FROM fs_paths WHERE path = ?", oldPath);
      db.run(
        `UPDATE fs_nodes
            SET nlink = (SELECT count(*) FROM fs_paths
                          WHERE inode = fs_nodes.inode),
                rev = (SELECT v FROM fs_meta WHERE k = 'rev')
          WHERE inode = ?`,
        classified.source_inode,
      );
      return;
    }
    if (classified !== undefined && classified.target_child === 1) {
      throw fsError("ENOTEMPTY", "directory not empty", newPath);
    }
    db.run(BUMP_REV);
    db.run(
      `DELETE FROM fs_chunks
        WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?)
          AND 1 = (SELECT count(*) FROM fs_paths
                    WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?))`,
      newPath,
      newPath,
    );
    db.run(
      `DELETE FROM fs_nodes
        WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?)
          AND 1 = (SELECT count(*) FROM fs_paths
                    WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?))`,
      newPath,
      newPath,
    );
    db.run(
      `UPDATE fs_nodes
          SET nlink = (SELECT count(*) - 1 FROM fs_paths
                        WHERE inode = fs_nodes.inode),
              rev = (SELECT v FROM fs_meta WHERE k = 'rev')
        WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?)
          AND 1 < (SELECT count(*) FROM fs_paths
                    WHERE inode = (SELECT inode FROM fs_paths WHERE path = ?))`,
      newPath,
      newPath,
    );
    db.run("DELETE FROM fs_paths WHERE path = ?", newPath);
    db.run(
      RENAME_SUBTREE,
      newPath,
      oldLength,
      oldPath,
      newPath,
      newPath,
      oldLength,
      oldPath,
      subtreeSuccessor(oldPath),
    );
    db.run(
      "UPDATE fs_paths SET path = ?, parent = ? WHERE path = ?",
      newPath,
      dirname(newPath),
      oldPath,
    );
    db.run(
      `UPDATE fs_nodes
          SET rev = (SELECT v FROM fs_meta WHERE k = 'rev')
        WHERE inode IN (
          SELECT inode FROM fs_paths
           WHERE path = ? OR (path >= ? || '/' AND path < ?)
        )`,
      newPath,
      newPath,
      subtreeSuccessor(newPath),
    );
  });
}
