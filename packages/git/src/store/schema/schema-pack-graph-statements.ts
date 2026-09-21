const OWNER = `repo_id INTEGER NOT NULL CHECK (typeof(repo_id) = 'integer' AND repo_id >= 1),
  op_id TEXT NOT NULL CHECK (typeof(op_id) = 'text' AND length(op_id) > 0)`;
const OWNER_FOREIGN_KEY = `FOREIGN KEY (repo_id, op_id)
  REFERENCES git_pack_graph_operations (repo_id, op_id) ON DELETE CASCADE`;
const OID = `oid TEXT NOT NULL CHECK (typeof(oid) = 'text' AND length(CAST(oid AS BLOB)) = 40)`;

export const PACK_GRAPH_SCHEMA_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS git_pack_objects_reverse
     ON git_pack_objects (repo_id, base_oid, oid) WHERE base_oid IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS git_pack_graph_operations (
     ${OWNER}, PRIMARY KEY (repo_id, op_id),
     FOREIGN KEY (repo_id) REFERENCES git_repositories (id) ON DELETE CASCADE
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS git_pack_graph_affected (
     ${OWNER}, ${OID},
     pending INTEGER NOT NULL CHECK (typeof(pending) = 'integer' AND pending IN (0,1)),
     cursor TEXT NOT NULL CHECK (
       typeof(cursor) = 'text' AND (cursor = '' OR length(CAST(cursor AS BLOB)) = 40)
     ),
     PRIMARY KEY (repo_id, op_id, oid), ${OWNER_FOREIGN_KEY}
   ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS git_pack_graph_pending
     ON git_pack_graph_affected (repo_id, op_id, pending, oid)`,
  `CREATE TABLE IF NOT EXISTS git_pack_graph_memo (
     ${OWNER}, ${OID},
     depth INTEGER NOT NULL CHECK (typeof(depth) = 'integer' AND depth BETWEEN 0 AND 9007199254740991),
     type TEXT NOT NULL CHECK (typeof(type) = 'text' AND type IN ('blob','tree','commit','tag')),
     PRIMARY KEY (repo_id, op_id, oid), ${OWNER_FOREIGN_KEY}
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS git_pack_graph_path (
     ${OWNER}, ${OID},
     position INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position BETWEEN 0 AND 9007199254740991),
     PRIMARY KEY (repo_id, op_id, oid), UNIQUE (repo_id, op_id, position), ${OWNER_FOREIGN_KEY}
   ) WITHOUT ROWID`,
];
