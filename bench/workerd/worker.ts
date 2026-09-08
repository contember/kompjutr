import {
  createGit,
  type DurableObjectStorageLike,
  type SQLCursorLike,
  type SQLStorageLike,
  Workspace,
} from "../../packages/do/src/index.js";

interface DurableObjectContextLike {
  storage: DurableObjectStorageLike;
}

interface CloneInput {
  originUrl: string;
  expectedHead: string;
  expectedFiles: number;
}

class CountingSqlStorage implements SQLStorageLike {
  statements = 0;
  rows = 0;

  constructor(private readonly inner: SQLStorageLike) {}

  exec<Row extends object = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): SQLCursorLike<Row> {
    this.statements++;
    return new CountingCursor(this.inner.exec<Row>(query, ...bindings), () => this.rows++);
  }

  reset(): void {
    this.statements = 0;
    this.rows = 0;
  }
}

class CountingCursor<Row extends object> implements SQLCursorLike<Row> {
  constructor(
    private readonly inner: SQLCursorLike<Row>,
    private readonly count: () => void,
  ) {}

  *[Symbol.iterator](): Iterator<Row> {
    for (const row of this.inner) {
      this.count();
      yield row;
    }
  }

  toArray(): Row[] {
    const rows = this.inner.toArray();
    for (const _row of rows) this.count();
    return rows;
  }
}

class CountingStorage implements DurableObjectStorageLike {
  readonly sql: CountingSqlStorage;

  constructor(private readonly inner: DurableObjectStorageLike) {
    this.sql = new CountingSqlStorage(inner.sql);
  }

  transactionSync<T>(closure: () => T): T {
    if (this.inner.transactionSync === undefined) {
      throw new Error("SqlStorage has no transactionSync");
    }
    return this.inner.transactionSync(closure);
  }
}

function cloneInput(value: unknown): CloneInput {
  if (typeof value !== "object" || value === null) throw new Error("invalid clone input");
  const originUrl = Reflect.get(value, "originUrl");
  const expectedHead = Reflect.get(value, "expectedHead");
  const expectedFiles = Reflect.get(value, "expectedFiles");
  if (
    typeof originUrl !== "string" ||
    typeof expectedHead !== "string" ||
    !/^[0-9a-f]{40}$/.test(expectedHead) ||
    typeof expectedFiles !== "number" ||
    !Number.isSafeInteger(expectedFiles) ||
    expectedFiles < 0
  ) {
    throw new Error("invalid clone input");
  }
  return { originUrl, expectedHead, expectedFiles };
}

function databaseBytes(storage: DurableObjectStorageLike): number {
  const value = Reflect.get(storage.sql, "databaseSize");
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("SqlStorage did not report databaseSize");
  }
  return value;
}

function validateCheckout(workspace: Workspace): {
  trackedFiles: number;
  worktreeFiles: number;
  invalidFiles: number;
} {
  const row = workspace.db.one<{
    tracked_files: number;
    worktree_files: number;
    invalid_files: number;
  }>(
    `SELECT COUNT(*) AS tracked_files,
            (SELECT COUNT(*)
               FROM fs_paths worktree_path
               JOIN fs_nodes worktree_node ON worktree_node.inode = worktree_path.inode
              WHERE worktree_path.path GLOB '/repo/*' AND worktree_node.type <> 'dir'
            ) AS worktree_files,
            COALESCE(SUM(CASE
              WHEN path.inode IS NULL OR node.content_id IS NULL
                OR lower(hex(node.content_id)) <> index_entry.oid
                OR (index_entry.mode = 33188 AND (node.type <> 'file' OR node.mode <> 420))
                OR (index_entry.mode = 33261 AND (node.type <> 'file' OR node.mode <> 493))
                OR (index_entry.mode = 40960 AND node.type <> 'symlink')
                OR index_entry.mode NOT IN (33188, 33261, 40960)
              THEN 1 ELSE 0 END), 0) AS invalid_files
       FROM git_index index_entry
       JOIN git_repositories repo ON repo.id = index_entry.repo_id
       LEFT JOIN fs_paths path ON path.path = repo.root || '/' || index_entry.path
       LEFT JOIN fs_nodes node ON node.inode = path.inode
      WHERE repo.root = '/repo' AND index_entry.stage = 0`,
  );
  if (
    row === undefined ||
    !Number.isSafeInteger(row.tracked_files) ||
    row.tracked_files < 0 ||
    !Number.isSafeInteger(row.worktree_files) ||
    row.worktree_files < 0 ||
    !Number.isSafeInteger(row.invalid_files) ||
    row.invalid_files < 0
  ) {
    throw new Error("checkout validation returned an invalid row");
  }
  return {
    trackedFiles: row.tracked_files,
    worktreeFiles: row.worktree_files,
    invalidFiles: row.invalid_files,
  };
}

export class CloneBench {
  readonly #platformStorage: DurableObjectStorageLike;
  readonly #storage: CountingStorage;
  readonly #workspace: Workspace;

  constructor(context: DurableObjectContextLike) {
    this.#platformStorage = context.storage;
    this.#storage = new CountingStorage(context.storage);
    this.#workspace = new Workspace({
      storage: this.#storage,
      git: createGit(),
      now: () => 1_577_836_800_000,
      defaultGitIdentity: { name: "Bench", email: "bench@example.com" },
    });
    void this.#workspace.git;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    try {
      const input = cloneInput(await request.json());
      this.#storage.sql.reset();
      await this.#workspace.git.clone({
        url: input.originUrl,
        dir: "/repo",
        ref: "main",
        depth: 1,
        singleBranch: true,
      });
      const statements = this.#storage.sql.statements;
      const rows = this.#storage.sql.rows;
      const head = await this.#workspace.git.revParse({ dir: "/repo", ref: "HEAD" });
      const checkout = validateCheckout(this.#workspace);
      const result = {
        statements,
        rows,
        trackedFiles: checkout.trackedFiles,
        worktreeFiles: checkout.worktreeFiles,
        invalidFiles: checkout.invalidFiles,
        head,
        databaseBytes: databaseBytes(this.#platformStorage),
      };
      if (result.head !== input.expectedHead) throw new Error("clone HEAD does not match fixture");
      if (result.trackedFiles !== input.expectedFiles) {
        throw new Error(`clone has ${result.trackedFiles} tracked files`);
      }
      if (result.worktreeFiles !== input.expectedFiles) {
        throw new Error(`clone has ${result.worktreeFiles} worktree files`);
      }
      if (result.invalidFiles !== 0) {
        throw new Error(`clone has ${result.invalidFiles} invalid worktree files`);
      }
      return Response.json(result);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return Response.json({ error: message }, { status: 500 });
    }
  }
}

export default {
  fetch(): Response {
    return new Response("not found", { status: 404 });
  },
};
