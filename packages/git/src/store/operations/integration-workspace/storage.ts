import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../../common/errors.js";
import { type Decoder, expectText } from "../../../common/rows.js";
import { JSON_BATCH_BYTES, jsonPages, utf8ByteLength } from "../../core/json-pages.js";

export const INTEGRATION_PAGE_ROWS = 256;

export class IntegrationWorkspaceOwner {
  #active = true;
  readonly #cursors = new Set<Iterator<unknown>>();

  constructor(
    readonly db: SqlDatabase,
    readonly repoId: number,
    readonly workspaceId: string,
    private readonly requireHealthy: () => void,
  ) {}

  requireActive(): void {
    if (!this.#active) throw new GitError("ESTALE", "integration workspace is no longer active");
    this.requireHealthy();
  }

  revoke(): void {
    this.#active = false;
    this.closeCursors();
  }

  closeCursors(): void {
    for (const cursor of this.#cursors) cursor.return?.();
    this.#cursors.clear();
  }

  *scoped<T>(entries: Iterable<T>): Generator<T> {
    this.requireActive();
    const cursor = entries[Symbol.iterator]();
    this.#cursors.add(cursor);
    try {
      while (true) {
        this.requireActive();
        const item = cursor.next();
        if (item.done) return;
        yield item.value;
      }
    } finally {
      this.#cursors.delete(cursor);
      cursor.return?.();
    }
  }
}

/**
 * A keyset page that drained its whole cursor below the row limit is the last
 * one: the limit did not truncate the query, so no row beyond it exists. A page
 * the byte cap cut short stopped before its cursor ran out, so rows may remain
 * even when it carries fewer than `INTEGRATION_PAGE_ROWS` of them, and that
 * page must still be followed by the next query.
 */
export function isFinalKeysetPage(scanned: number, byteCapped: boolean): boolean {
  return !byteCapped && scanned < INTEGRATION_PAGE_ROWS;
}

export function decodeDescriptor<T>(decoder: Decoder<T>, value: unknown, stored: boolean): T {
  const result = decoder.tryDecode(value);
  if (result.ok) return result.value;
  if (stored) throw new CorruptError(result.message);
  throw new GitError("EINVAL", result.message);
}

export function* integrationJsonPages<T>(entries: Iterable<T>): Generator<string> {
  for (const page of integrationPages(entries)) yield* jsonPages(page, "integration workspace");
}

export function* integrationPages<T>(entries: Iterable<T>): Generator<T[]> {
  let page: T[] = [];
  let bytes = 2;
  for (const entry of entries) {
    const size = utf8ByteLength(JSON.stringify(entry));
    if (
      page.length > 0 &&
      (page.length === INTEGRATION_PAGE_ROWS || bytes + size + 1 > JSON_BATCH_BYTES)
    ) {
      yield page;
      page = [];
      bytes = 2;
    }
    page.push(entry);
    bytes += size + 1;
    if (bytes >= JSON_BATCH_BYTES) {
      yield page;
      page = [];
      bytes = 2;
    }
  }
  if (page.length > 0) yield page;
}

export class IntegrationPlanEntries<T extends { path: string }> implements Iterable<T> {
  constructor(
    private readonly owner: IntegrationWorkspaceOwner,
    readonly planId: number,
    private readonly decoder: Decoder<T>,
    private readonly replace: boolean,
  ) {}

  write(entries: Iterable<T>): void {
    const owner = this.owner;
    owner.requireActive();
    const checked = this.checked(entries);
    for (const page of integrationJsonPages(checked)) {
      owner.requireActive();
      owner.db.run(
        `INSERT INTO git_integration_plan_entries (repo_id, workspace_id, plan_id, path, descriptor)
         SELECT ?, ?, ?, json_extract(value, '$.path'), value FROM json_each(?)
         WHERE 1
         ${this.replace ? "ON CONFLICT (repo_id, workspace_id, plan_id, path) DO UPDATE SET descriptor = excluded.descriptor" : ""}`,
        owner.repoId,
        owner.workspaceId,
        this.planId,
        page,
      );
    }
  }

  private *checked(entries: Iterable<T>): Generator<T> {
    for (const entry of entries) {
      this.owner.requireActive();
      yield decodeDescriptor(this.decoder, entry, false);
    }
  }

  get(path: string): T | null {
    const owner = this.owner;
    owner.requireActive();
    const row = owner.db.one<{ descriptor: unknown }>(
      `SELECT descriptor FROM git_integration_plan_entries
       WHERE repo_id = ? AND workspace_id = ? AND plan_id = ? AND path = ?`,
      owner.repoId,
      owner.workspaceId,
      this.planId,
      path,
    );
    if (row === undefined) return null;
    const value: unknown = JSON.parse(expectText(row.descriptor));
    return decodeDescriptor(this.decoder, value, true);
  }

  getMany(paths: readonly string[]): Map<string, T> {
    const owner = this.owner;
    owner.requireActive();
    const found = new Map<string, T>();
    for (const page of integrationJsonPages(paths)) {
      for (const row of owner.db.iterate(
        `SELECT path, descriptor FROM git_integration_plan_entries
         WHERE repo_id = ? AND workspace_id = ? AND plan_id = ?
           AND path IN (SELECT value FROM json_each(?))`,
        owner.repoId,
        owner.workspaceId,
        this.planId,
        page,
      )) {
        const value: unknown = JSON.parse(expectText(row.descriptor));
        found.set(expectText(row.path), decodeDescriptor(this.decoder, value, true));
      }
    }
    return found;
  }

  *[Symbol.iterator](): Generator<T> {
    const owner = this.owner;
    owner.requireActive();
    let after = "";
    while (true) {
      owner.requireActive();
      const page: T[] = [];
      let bytes = 0;
      let scanned = 0;
      let byteCapped = false;
      for (const row of owner.db.iterate(
        `SELECT path, descriptor FROM git_integration_plan_entries
         WHERE repo_id = ? AND workspace_id = ? AND plan_id = ? AND path > ? COLLATE BINARY
         ORDER BY path COLLATE BINARY LIMIT ${INTEGRATION_PAGE_ROWS}`,
        owner.repoId,
        owner.workspaceId,
        this.planId,
        after,
      )) {
        scanned++;
        const descriptor = expectText(row.descriptor);
        const size = utf8ByteLength(descriptor);
        if (page.length > 0 && bytes + size > JSON_BATCH_BYTES) {
          byteCapped = true;
          break;
        }
        const value: unknown = JSON.parse(descriptor);
        page.push(decodeDescriptor(this.decoder, value, true));
        after = expectText(row.path);
        bytes += size;
        if (bytes >= JSON_BATCH_BYTES) {
          byteCapped = true;
          break;
        }
      }
      if (page.length === 0) return;
      const final = isFinalKeysetPage(scanned, byteCapped);
      for (const entry of page) {
        owner.requireActive();
        yield entry;
      }
      if (final) return;
    }
  }
}

export class IntegrationPlanHandle<T extends { path: string }> {
  readonly entries: IntegrationPlanEntries<T>;
  #sourceRows = 0;
  #entryCount = 0;

  constructor(
    private readonly owner: IntegrationWorkspaceOwner,
    readonly planId: number,
    decoder: Decoder<T>,
    replace: boolean,
  ) {
    this.entries = new IntegrationPlanEntries(owner, planId, decoder, replace);
  }

  get sourceRows(): number {
    this.owner.requireActive();
    return this.#sourceRows;
  }

  get entryCount(): number {
    this.owner.requireActive();
    return this.#entryCount;
  }

  finish(sourceRows: number, entryCount: number): void {
    this.owner.requireActive();
    if (
      !Number.isSafeInteger(sourceRows) ||
      sourceRows < 0 ||
      !Number.isSafeInteger(entryCount) ||
      entryCount < 0
    ) {
      throw new GitError("EINVAL", "integration plan counts are invalid");
    }
    this.owner.db.run(
      `UPDATE git_integration_plans SET source_rows = ?, entry_count = ?
       WHERE repo_id = ? AND workspace_id = ? AND plan_id = ?`,
      sourceRows,
      entryCount,
      this.owner.repoId,
      this.owner.workspaceId,
      this.planId,
    );
    this.#sourceRows = sourceRows;
    this.#entryCount = entryCount;
  }
}
