import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type PolicyBoundary =
  | "ordinary-read"
  | "schema-validation"
  | "write"
  | "json-ordinal"
  | "network-ingest"
  | "filesystem-handle"
  | "algorithmic";

interface ReadQuery {
  category: string;
  name: string;
  sql: string;
}

interface QueryScope {
  category: string;
  name: string;
  path: string;
  start: string;
  end?: string;
  classify?: (sql: string) => PolicyBoundary;
}

const FORBIDDEN_SQL_WITNESSES: readonly [name: string, pattern: RegExp][] = [
  ["storage-class authentication", /\btypeof\s*\(/iu],
  ["encoded-text authentication", /\bhex\s*\(\s*(?:[a-z_]\w*\.)?[a-z_]\w*\s*\)/iu],
  ["detached journal authentication", /\bintegrity_oid\b/iu],
  [
    "metadata-preflight authentication",
    /\b(?:root_valid|baseline_valid|invalid_types|text_bytes|row_count)\b/iu,
  ],
];

const FORBIDDEN_JOURNAL_AUTHENTICATION: readonly [name: string, pattern: RegExp][] = [
  ["detached journal identity", /\b(?:integrity_oid|operationJournalIntegrityOid)\b/u],
  [
    "whole-journal object authentication",
    /(?:#validateOperationObjects|#validateOperationCommitBodies|objects\.(?:objectInfo|readObjects))\s*\(/u,
  ],
  [
    "whole-journal topology authentication",
    /(?:#validateReplayTopology|validateOperationJournal)\s*\(/u,
  ],
];

function scopedSource(path: string, start: string, end?: string): string {
  const contents = readFileSync(join(process.cwd(), path), "utf8");
  const from = contents.indexOf(start);
  if (from < 0) throw new Error(`${path} lost policy scope marker ${start}`);
  const until = end === undefined ? contents.length : contents.indexOf(end, from + start.length);
  if (until < 0) throw new Error(`${path} lost policy scope marker ${end}`);
  return contents.slice(from, until);
}

function readSqlLiterals(contents: string): string[] {
  const literals: string[] = [];
  const pattern = /`([^`]*)`|"([^"\n]*(?:SELECT|WITH)[^"\n]*)"/gu;
  for (const match of contents.matchAll(pattern)) {
    const sql = match[1] ?? match[2];
    if (sql !== undefined && /^\s*(?:SELECT|WITH)\b/iu.test(sql)) literals.push(sql);
  }
  return literals;
}

function ordinaryReadInventory(): ReadQuery[] {
  const journal = "src/git/store/operation-journal.ts";
  const scopes: readonly QueryScope[] = [
    {
      category: "operation journal",
      name: "complete operation read",
      path: journal,
      start: "  readOperationState(): OperationJournal | null {",
      end: "  readRebaseCursorOwned(): RebaseJournalCursor | null {",
    },
    {
      category: "operation journal",
      name: "rebase cursor read",
      path: journal,
      start: "  readRebaseCursorOwned(): RebaseJournalCursor | null {",
      end: "  writeOperationState(",
    },
    {
      category: "operation journal",
      name: "operation-root page",
      path: journal,
      start: "  operationRootPage(cursor = 0, limit = 128): OperationRootPage {",
      end: "  readMergeState(): MergeJournal | null {",
    },
    {
      category: "index tracker",
      name: "tracker state",
      path: "src/git/store/index-tracker.ts",
      start: "export function readIndexTrackerState(",
      end: "function* dirtyRows(",
    },
    {
      category: "index tracker",
      name: "dirty-path page",
      path: "src/git/store/index-tracker.ts",
      start: "function* dirtyRows(",
      end: "export function iterateIndexTrackerDirty(",
    },
    {
      category: "sparse selection",
      name: "native selection",
      path: "src/git/store/sparse/selection.ts",
      start: "const CHECKOUT_ROW",
    },
    {
      category: "sparse tree resolution",
      name: "tree-depth projection",
      path: "src/git/store/sparse/tree-resolution.ts",
      start: "export const SPARSE_TREE_DEPTH_SQL",
      end: "const TREE_DEPTH_ROW",
    },
    {
      category: "sparse workspace",
      name: "native workspace",
      path: "src/git/store/sparse/workspace.ts",
      start: "const INDEX_SQL",
    },
    {
      category: "sparse snapshot",
      name: "native snapshot",
      path: "src/git/store/sparse/snapshot.ts",
      start: "const SNAPSHOT_DIRTY_SQL",
      classify: (sql) => {
        if (!sql.includes("sqlite_master")) return "ordinary-read";
        expect(sql.trim()).toBe(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'git_index_state'",
        );
        return "schema-validation";
      },
    },
    {
      category: "loose-object payload",
      name: "joined payload stream",
      path: "src/git/store/objects.ts",
      start: "  #readLooseObjects(oids: readonly string[]): Map<string, RawObject> {",
      end: "  #looseObjectMetadata(",
    },
    {
      category: "maintenance roots",
      name: "root source pages",
      path: "src/git/store/maintenance/roots.ts",
      start: "function rootsFromRefs(",
      end: "function validateObjectRoots(",
    },
  ];

  const queries: ReadQuery[] = [];
  for (const scope of scopes) {
    const literals = readSqlLiterals(scopedSource(scope.path, scope.start, scope.end));
    if (literals.length === 0) throw new Error(`${scope.name} lost its SQL inventory`);
    for (let ordinal = 0; ordinal < literals.length; ordinal++) {
      const sql = literals[ordinal];
      if (sql === undefined) throw new Error(`${scope.name} produced a sparse SQL inventory`);
      const boundary = scope.classify?.(sql) ?? "ordinary-read";
      if (boundary === "ordinary-read") {
        queries.push({ category: scope.category, name: `${scope.name} ${ordinal + 1}`, sql });
      }
    }
  }
  return queries;
}

function hasAuthenticationBlobCast(sql: string): boolean {
  const pattern = /\bcast\s*\(\s*(?:[a-z_]\w*\.)?[a-z_]\w*\s+as\s+blob\s*\)/giu;
  for (const match of sql.matchAll(pattern)) {
    const index = match.index;
    if (index === undefined) return true;
    const prefix = sql.slice(Math.max(0, index - 40), index);
    if (!/edge\.name_bytes\s*=\s*$/iu.test(prefix)) return true;
  }
  return false;
}

function hasAuthenticationLength(sql: string): boolean {
  const algorithmicPathRelationship =
    /length\(path\.path\)\s*<\s*length\(wanted\.path\)\s+and\s+substr\(wanted\.path,\s*1,\s*length\(path\.path\)\s*\+\s*1\)/iu;
  const inspected = sql.replace(algorithmicPathRelationship, "");
  return /\blength\s*\(\s*(?:[a-z_]\w*\.)?[a-z_]\w*\s*\)/iu.test(inspected);
}

function policyViolations(sql: string, boundary: PolicyBoundary): string[] {
  if (boundary !== "ordinary-read") return [];
  const violations = FORBIDDEN_SQL_WITNESSES.filter(([, pattern]) => pattern.test(sql)).map(
    ([name]) => name,
  );
  if (hasAuthenticationBlobCast(sql)) violations.push("BLOB-cast authentication");
  if (hasAuthenticationLength(sql)) violations.push("length authentication");
  return violations;
}

function journalReaderViolations(source: string): string[] {
  return FORBIDDEN_JOURNAL_AUTHENTICATION.filter(([, pattern]) => pattern.test(source)).map(
    ([name]) => name,
  );
}

describe("trusted ordinary read policy", () => {
  it("exhaustively classifies the WU1-WU6 ordinary read scopes", () => {
    const categories: Record<string, number> = {};
    for (const query of ordinaryReadInventory()) {
      categories[query.category] = (categories[query.category] ?? 0) + 1;
      expect(policyViolations(query.sql, "ordinary-read"), query.name).toEqual([]);
    }
    expect(categories).toEqual({
      "operation journal": 7,
      "index tracker": 2,
      "sparse selection": 7,
      "sparse tree resolution": 1,
      "sparse workspace": 4,
      "sparse snapshot": 5,
      "loose-object payload": 1,
      "maintenance roots": 8,
    });
  });

  it("rejects every authentication shape removed from ordinary SQL", () => {
    const regressions: readonly [name: string, sql: string][] = [
      [
        "storage class",
        "SELECT CASE WHEN typeof(path) = 'text' THEN path END AS path FROM git_index",
      ],
      ["BLOB cast", "SELECT path FROM git_index WHERE CAST(path AS BLOB) = CAST(? AS BLOB)"],
      ["length", "SELECT path, length(path) AS path_bytes FROM git_index"],
      ["hex", "SELECT path FROM git_index WHERE hex(path) = ?"],
      ["integrity identity", "SELECT integrity_oid FROM git_operation_state"],
      [
        "metadata preflight",
        "SELECT count(*) AS row_count, sum(length(name)) AS text_bytes FROM git_refs",
      ],
    ];
    for (const [name, sql] of regressions) {
      expect(policyViolations(sql, "ordinary-read"), name).not.toEqual([]);
    }
  });

  it("keeps complete journal readers free of detached and whole-plan authentication", () => {
    const path = "src/git/store/operation-journal.ts";
    const readers = [
      scopedSource(
        path,
        "  readOperationState(): OperationJournal | null {",
        "  readRebaseCursorOwned(): RebaseJournalCursor | null {",
      ),
      scopedSource(
        path,
        "  readRebaseCursorOwned(): RebaseJournalCursor | null {",
        "  writeOperationState(",
      ),
    ];
    for (const reader of readers) expect(journalReaderViolations(reader)).toEqual([]);

    const regressions = [
      "const integrity = operationJournalIntegrityOid(state, touched, steps);",
      "this.#validateOperationObjects(journal);",
      "this.#validateReplayTopology(journal, sizes);",
      "validateOperationJournal(state, touched, steps);",
      "this.objects.objectInfo(expected);",
    ];
    for (const regression of regressions) {
      expect(journalReaderViolations(regression), regression).not.toEqual([]);
    }
  });

  it("allows exact boundary and algorithmic SQL without creating a broad exemption", () => {
    const allowed: readonly [boundary: Exclude<PolicyBoundary, "ordinary-read">, sql: string][] = [
      ["schema-validation", "SELECT typeof(sql), length(sql) FROM sqlite_schema"],
      ["write", "UPDATE git_refs SET target = ? WHERE typeof(name) = 'text'"],
      ["json-ordinal", "SELECT CAST(key AS INTEGER) FROM json_each(?)"],
      ["network-ingest", "SELECT typeof(frame), hex(frame) FROM incoming_pack"],
      ["filesystem-handle", "SELECT typeof(rev) FROM fs_nodes WHERE inode = ?"],
      ["algorithmic", "SELECT CASE WHEN depth > 64 THEN 1 ELSE 0 END FROM walk"],
    ];
    for (const [boundary, sql] of allowed) {
      expect(policyViolations(sql, boundary), boundary).toEqual([]);
    }
    expect(
      policyViolations(
        "SELECT edge.oid FROM git_tree_entries edge WHERE edge.name_bytes = CAST(wanted.segment AS BLOB)",
        "ordinary-read",
      ),
    ).toEqual([]);
  });
});
