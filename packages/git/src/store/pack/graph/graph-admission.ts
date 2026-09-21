import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../../common/errors.js";
import type { ObjectType } from "../../../common/objects.js";
import { int, nullable, oneOf, RowShape, text } from "../../../common/rows.js";
import { GRAPH_PAGE, graphSql } from "./graph-sql.js";

const objectType = oneOf(["blob", "tree", "commit", "tag"]);
const reverseRow = new RowShape({ parent: text(), child: nullable(text()) });
const forwardRow = new RowShape({
  oid: text(),
  root: text(),
  type: nullable(objectType),
  base: nullable(text()),
  depth: nullable(int(0)),
  memo_type: nullable(objectType),
  active: oneOf([0, 1]),
});
const rootRow = new RowShape({ oid: text() });

// The shared adapters accept anonymous positional bindings, not SQLite's numbered names.
const statements = new Map(
  Object.values(graphSql).map((source) => {
    const positions: number[] = [];
    const sql = source.replace(/\?(\d+)/g, (_match, index: string) => {
      positions.push(Number(index) - 1);
      return "?";
    });
    return [source, { sql, positions }];
  }),
);

interface Memo {
  oid: string;
  depth: number;
  type: ObjectType;
}
interface Path {
  oid: string;
  position: number;
}
interface Progress {
  oid: string;
  cursor: string;
  pending: number;
}

export class PackGraphAdmission {
  readonly #opId = crypto.randomUUID();

  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly maxDepth: number,
    private readonly failure: "publication" | "deletion",
  ) {
    db.run(
      "INSERT INTO git_pack_graph_operations (repo_id, op_id) VALUES (?, ?)",
      repoId,
      this.#opId,
    );
  }

  seedPacks(packIds: readonly number[]): void {
    this.db.run(
      `INSERT OR IGNORE INTO git_pack_graph_affected (repo_id, op_id, oid, pending, cursor)
       SELECT repo_id, ?, oid, 1, '' FROM git_pack_objects
       WHERE repo_id = ? AND pack_id IN (SELECT value FROM json_each(?))`,
      this.#opId,
      this.repoId,
      JSON.stringify(packIds),
    );
  }

  #bind(source: string, values: readonly (string | number)[]): [string, ...(string | number)[]] {
    const statement = statements.get(source);
    if (statement === undefined) throw new Error("unknown pack graph statement");
    const parameters = [this.repoId, this.#opId, ...values];
    return [
      statement.sql,
      ...statement.positions.map((position) => {
        const value = parameters[position];
        if (value === undefined) throw new Error("missing pack graph parameter");
        return value;
      }),
    ];
  }

  #run(source: string, ...values: (string | number)[]): void {
    this.db.run(...this.#bind(source, values));
  }

  #rows(source: string, ...values: (string | number)[]): Iterable<Record<string, unknown>> {
    return this.db.iterate(...this.#bind(source, values));
  }

  #json(source: string, rows: readonly (string | Memo | Path | Progress)[]): void {
    if (rows.length === 0) return;
    if (rows.length > GRAPH_PAGE) throw new CorruptError("pack graph page exceeds its bound");
    this.#run(source, JSON.stringify(rows));
  }

  #reject(message: string): never {
    if (this.failure === "deletion") throw new GitError("EBUSY", message);
    throw new CorruptError(message);
  }

  #reverse(): void {
    for (;;) {
      const updates = new Map<string, Progress>();
      const children: string[] = [];
      for (const raw of this.#rows(graphSql.reverse)) {
        const row = reverseRow.decode(raw);
        const previous = updates.get(row.parent);
        updates.set(row.parent, {
          oid: row.parent,
          cursor: row.child ?? previous?.cursor ?? "",
          pending: row.child === null ? 0 : 1,
        });
        if (row.child !== null) children.push(row.child);
      }
      if (updates.size === 0) return;
      this.#json(graphSql.seed, children);
      this.#json(graphSql.advance, [...updates.values()]);
    }
  }

  #checkDepth(depth: number): void {
    if (depth > this.maxDepth) this.#reject(`delta chain deeper than ${this.maxDepth}`);
  }

  #unwind(length: number, depth: number, type: ObjectType): void {
    this.#checkDepth(length + depth);
    for (let high = length; high > 0; ) {
      const low = Math.max(0, high - GRAPH_PAGE);
      this.#run(graphSql.unwind, depth, length, type, low, high);
      this.#run(graphSql.trim, low, high);
      high = low;
    }
  }

  #firstRoot(cursor: string): string | undefined {
    for (const raw of this.#rows(graphSql.firstRoot, cursor)) return rootRow.decode(raw).oid;
    return undefined;
  }

  #forward(): void {
    let cursor = "";
    let start = this.#firstRoot(cursor);
    let root = start;
    let length = 0;
    let expectedType: ObjectType | undefined;
    while (start !== undefined && root !== undefined) {
      // Finish reading the page before unwind writes invalidate its active-path snapshot.
      const rows = Array.from(this.#rows(graphSql.forward, start, root), (raw) =>
        forwardRow.decode(raw),
      );
      const memo: Memo[] = [];
      let segment: Path[] = [];
      let seen = new Set<string>();
      let next: string | undefined;
      for (const row of rows) {
        root = row.root;
        if (row.type === null && row.oid === root && length === 0 && segment.length === 0) {
          cursor = root;
          expectedType = undefined;
          next = undefined;
          continue;
        }
        if (row.type === null) this.#reject(`missing delta base ${row.oid}`);
        if (row.active === 1 || seen.has(row.oid)) this.#reject(`cyclic delta chain at ${row.oid}`);
        expectedType ??= row.type;
        if (row.type !== expectedType || (row.depth !== null && row.memo_type !== expectedType)) {
          this.#reject(`delta base type mismatch at ${row.oid}`);
        }
        if (row.depth !== null || row.base === null) {
          const depth = row.depth ?? 0;
          this.#checkDepth(depth + length + segment.length);
          if (row.depth === null) memo.push({ oid: row.oid, depth: 0, type: row.type });
          for (const [index, entry] of segment.entries()) {
            memo.push({ oid: entry.oid, depth: depth + segment.length - index, type: row.type });
          }
          this.#unwind(length, depth + segment.length, row.type);
          length = 0;
          segment = [];
          seen = new Set();
          expectedType = undefined;
          cursor = root;
          next = undefined;
        } else {
          seen.add(row.oid);
          segment.push({ oid: row.oid, position: length + segment.length });
          this.#checkDepth(length + segment.length);
          next = row.base;
        }
      }
      this.#json(graphSql.memo, memo);
      this.#json(graphSql.path, segment);
      length += segment.length;
      start = next ?? this.#firstRoot(cursor);
      if (next === undefined) root = start;
    }
  }

  validate(): void {
    this.#reverse();
    this.#forward();
  }

  cleanup(): void {
    this.db.run(
      "DELETE FROM git_pack_graph_operations WHERE repo_id = ? AND op_id = ?",
      this.repoId,
      this.#opId,
    );
  }
}
