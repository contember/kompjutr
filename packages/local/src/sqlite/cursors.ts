import { normalizeSqlRow, rethrowSqliteError } from "@kompjutr/sqlite";
import { localError } from "../errors.js";

interface ScopedCursor {
  attach(scope: SqliteCursorScope): void;
  detach(scope: SqliteCursorScope): void;
  invalidate(): void;
}

export class SqliteCursorScope {
  readonly cursors = new Set<ScopedCursor>();

  constructor(readonly parent: SqliteCursorScope | undefined) {}

  release(): void {
    for (const cursor of this.cursors) {
      if (this.parent !== undefined) cursor.attach(this.parent);
      cursor.detach(this);
    }
  }

  rollback(): void {
    for (const cursor of this.cursors) cursor.invalidate();
  }
}

export function scopedSqliteRows(
  iterator: Iterator<Record<string, unknown>>,
  currentScope: () => SqliteCursorScope | undefined,
  observed: () => void,
): IterableIterator<Record<string, unknown>> {
  const scopes = new Set<SqliteCursorScope>();
  let invalid = false;
  let finished = false;
  const detachAll = (): void => {
    for (const scope of scopes) scope.cursors.delete(cursor);
    scopes.clear();
  };
  const close = (): void => {
    try {
      if (!finished) iterator.return?.();
    } finally {
      finished = true;
      detachAll();
    }
  };
  const cursor: ScopedCursor = {
    attach(scope) {
      scopes.add(scope);
      scope.cursors.add(cursor);
    },
    detach(scope) {
      scopes.delete(scope);
      scope.cursors.delete(cursor);
    },
    invalidate() {
      invalid = true;
      close();
    },
  };
  const createdIn = currentScope();
  if (createdIn !== undefined) cursor.attach(createdIn);
  return {
    [Symbol.iterator]() {
      return this;
    },
    next() {
      if (invalid) throw localError("ESTALE", "SQLite cursor belongs to a rolled-back scope");
      if (finished) return { done: true, value: undefined };
      const scope = currentScope();
      if (scope !== undefined) cursor.attach(scope);
      try {
        const step = iterator.next();
        if (step.done) {
          finished = true;
          detachAll();
          return { done: true, value: undefined };
        }
        observed();
        return { done: false, value: normalizeSqlRow(step.value) };
      } catch (error) {
        close();
        rethrowSqliteError(error);
      }
    },
    return() {
      close();
      return { done: true, value: undefined };
    },
  };
}
