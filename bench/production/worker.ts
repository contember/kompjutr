import { concat, utf8, utf8Decoder } from "../../src/core/bytes.js";
import { FLUSH, pkt } from "../../src/core/protocol/pktline.js";
import {
  fetchHttpClient,
  type GitHttpClient,
  type GitHttpRequest,
  type GitHttpResponse,
} from "../../src/core/protocol/transport.js";
import { createGit } from "../../src/git/client.js";
import { Workspace } from "../../src/runtime/workspace.js";
import type {
  DurableObjectStorageLike,
  SQLCursorLike,
  SQLStorageLike,
} from "../../src/sqlite/db.js";
import {
  PROBE_FIXTURE_BRANCH,
  PROBE_FIXTURE_FETCH_BRANCH,
  PROBE_FIXTURE_FETCH_HEAD,
  PROBE_FIXTURE_HEAD,
  PROBE_FIXTURE_URL,
  PROBE_HTTP_BODY_LIMIT,
  PROBE_RESPONSE_LIMIT,
  type ProbeMetrics,
  probeStatementTarget,
} from "./protocol.js";

const PRIMARY_DIR = "/repo";
const REBASE_CLEAN_DIR = "/rebase-clean";
const REBASE_CONTINUE_DIR = "/rebase-continue";
const REBASE_ABORT_DIR = "/rebase-abort";
const PUSH_URL = "https://probe.invalid/repository";
const PUSH_REF = "refs/heads/master";
const IDENTITY = { name: "Production Probe", email: "probe@example.com" };
const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

interface PlatformSqlStorage extends SQLStorageLike {
  readonly databaseSize: number;
}

interface PlatformStorage extends DurableObjectStorageLike {
  readonly sql: PlatformSqlStorage;
  deleteAll(): Promise<void>;
  transactionSync<T>(closure: () => T): T;
}

interface DurableObjectStateLike {
  readonly storage: PlatformStorage;
  abort(reason?: string): void;
}

interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespaceLike {
  getByName(name: string): DurableObjectStubLike;
}

interface VersionMetadataLike {
  readonly id: string;
  readonly tag: string;
  readonly timestamp: string;
}

interface WorkerEnv {
  readonly PROBE: DurableObjectNamespaceLike;
  readonly PROBE_TOKEN: string;
  readonly CF_VERSION_METADATA: VersionMetadataLike;
}

interface ForeignKeyRow {
  foreign_keys: unknown;
}

interface OrdinalRow {
  ordinal: unknown;
}

interface FactRow {
  value: unknown;
}

interface CheckRow {
  quick_check: unknown;
}

interface CountRow {
  count: unknown;
}

interface OperationResult {
  metrics: ProbeMetrics;
  facts: unknown;
}

class CountingSqlStorage implements SQLStorageLike {
  statements = 0;
  rows = 0;

  constructor(private readonly inner: PlatformSqlStorage) {}

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

  constructor(private readonly inner: PlatformStorage) {
    this.sql = new CountingSqlStorage(inner.sql);
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

function once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

function httpResponse(
  body: Uint8Array,
  contentType: string,
  status = 200,
  statusText = "OK",
): GitHttpResponse {
  return {
    status,
    statusText,
    headers: { "content-type": contentType },
    body: once(body),
  };
}

async function collectBody(body: GitHttpRequest["body"]): Promise<Uint8Array> {
  if (body === undefined) return new Uint8Array(0);
  if (body instanceof Uint8Array) {
    if (body.length > PROBE_HTTP_BODY_LIMIT) throw new Error("probe HTTP body exceeds limit");
    return body;
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of body) {
    if (chunk.length > PROBE_HTTP_BODY_LIMIT - bytes) {
      throw new Error("probe HTTP body exceeds limit");
    }
    chunks.push(chunk);
    bytes += chunk.length;
  }
  return concat(chunks);
}

function findPack(body: Uint8Array): number {
  for (let offset = 0; offset <= body.length - 4; offset++) {
    if (
      body[offset] === 0x50 &&
      body[offset + 1] === 0x41 &&
      body[offset + 2] === 0x43 &&
      body[offset + 3] === 0x4b
    ) {
      return offset;
    }
  }
  return -1;
}

function pushCommand(body: Uint8Array): { oldOid: string; newOid: string; ref: string } {
  if (body.length < 8) throw new Error("receive-pack request is truncated");
  const lengthText = utf8Decoder.decode(body.subarray(0, 4));
  const length = Number.parseInt(lengthText, 16);
  if (!Number.isSafeInteger(length) || length < 4 || length > body.length) {
    throw new Error("receive-pack command has invalid length");
  }
  const command = utf8Decoder.decode(body.subarray(4, length)).split("\0", 1)[0];
  if (command === undefined) throw new Error("receive-pack command is empty");
  const fields = command.trim().split(" ");
  const oldOid = fields[0];
  const newOid = fields[1];
  const ref = fields[2];
  if (
    oldOid === undefined ||
    newOid === undefined ||
    ref === undefined ||
    !/^[0-9a-f]{40}$/.test(oldOid) ||
    !/^[0-9a-f]{40}$/.test(newOid)
  ) {
    throw new Error("receive-pack command is malformed");
  }
  return { oldOid, newOid, ref };
}

class ProbeReceivePack {
  receivedBytes = 0;
  packOffset = -1;
  newOid: string | undefined;

  readonly http: GitHttpClient = async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "probe.invalid") return fetchHttpClient(request);

    if (request.method === "GET" && url.pathname.endsWith("/info/refs")) {
      const body = concat([
        pkt("# service=git-receive-pack\n"),
        FLUSH,
        pkt(`${PROBE_FIXTURE_HEAD} ${PUSH_REF}\0report-status agent=kompjutr-probe\n`),
        FLUSH,
      ]);
      return httpResponse(body, "application/x-git-receive-pack-advertisement");
    }

    if (request.method === "POST" && url.pathname.endsWith("/git-receive-pack")) {
      const body = await collectBody(request.body);
      const command = pushCommand(body);
      if (command.oldOid !== PROBE_FIXTURE_HEAD || command.ref !== PUSH_REF) {
        throw new Error("receive-pack command does not target the pinned fixture");
      }
      const packOffset = findPack(body);
      if (packOffset < 0) throw new Error("receive-pack request contains no pack");
      this.receivedBytes = body.length;
      this.packOffset = packOffset;
      this.newOid = command.newOid;
      const result = concat([pkt("unpack ok\n"), pkt(`ok ${PUSH_REF}\n`), FLUSH]);
      return httpResponse(result, "application/x-git-receive-pack-result");
    }

    return httpResponse(utf8.encode("not found"), "text/plain", 404, "Not Found");
  };
}

function pragmaForeignKeys(sql: PlatformSqlStorage): number {
  const row = sql.exec<ForeignKeyRow>("PRAGMA foreign_keys").toArray()[0];
  if (row === undefined || (row.foreign_keys !== 0 && row.foreign_keys !== 1)) {
    throw new Error("PRAGMA foreign_keys returned an invalid value");
  }
  return row.foreign_keys;
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is not a non-negative safe integer`);
  }
  return value;
}

function databaseBytes(storage: PlatformStorage): number {
  return nonnegativeInteger(storage.sql.databaseSize, "SqlStorage.databaseSize");
}

function probeMetrics(statements: number, rows: number): ProbeMetrics {
  return { statements, rows, statementTarget: probeStatementTarget(statements) };
}

function errorCode(error: unknown): string | undefined {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") {
    return undefined;
  }
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function checkedResponse(value: unknown, status = 200): Response {
  const text = JSON.stringify(value);
  if (utf8.encode(text).length > PROBE_RESPONSE_LIMIT) {
    return Response.json(
      { ok: false, error: "probe response exceeds bounded output" },
      { status: 500 },
    );
  }
  return new Response(text, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export class ProductionProbe {
  readonly #instanceId = crypto.randomUUID();
  readonly #state: DurableObjectStateLike;
  readonly #storage: PlatformStorage;
  readonly #counting: CountingStorage;
  readonly #workspace: Workspace;
  readonly #receiver = new ProbeReceivePack();
  readonly #foreignKeysBefore: number;
  readonly #foreignKeysAfter: number;
  readonly #constructorOrdinal: number;

  constructor(state: DurableObjectStateLike) {
    this.#state = state;
    this.#storage = state.storage;
    this.#foreignKeysBefore = pragmaForeignKeys(this.#storage.sql);
    this.#initializeProbeTables();
    this.#counting = new CountingStorage(this.#storage);
    this.#workspace = new Workspace({
      storage: this.#counting,
      git: createGit(),
      defaultGitIdentity: IDENTITY,
      http: this.#receiver.http,
      timezoneOffset: () => 0,
    });
    void this.#workspace.git;
    this.#foreignKeysAfter = pragmaForeignKeys(this.#storage.sql);
    this.#storage.sql.exec(
      `INSERT INTO probe_instance_events
         (instance_id, foreign_keys_before, foreign_keys_after, created_at)
       VALUES (?, ?, ?, ?)`,
      this.#instanceId,
      this.#foreignKeysBefore,
      this.#foreignKeysAfter,
      Date.now(),
    );
    const row = this.#storage.sql
      .exec<OrdinalRow>("SELECT max(ordinal) AS ordinal FROM probe_instance_events")
      .toArray()[0];
    this.#constructorOrdinal = nonnegativeInteger(row?.ordinal, "constructor ordinal");
  }

  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.slice(1);
    if (request.method !== "POST") {
      return checkedResponse({ ok: false, error: "method not allowed" }, 405);
    }

    if (action === "application-failure") {
      return this.#failure(action, new Error("intentional production probe application failure"));
    }
    if (action === "isolate-reset") {
      this.#state.abort("intentional production probe isolate reset");
      throw new Error("DurableObjectState.abort returned unexpectedly");
    }
    if (action === "storage-reset") {
      await this.#storage.deleteAll();
      return this.#success(action, {
        metrics: probeMetrics(0, 0),
        facts: { deleted: true },
      });
    }

    try {
      switch (action) {
        case "meta":
          return this.#success(action, { metrics: probeMetrics(0, 0), facts: {} });
        case "clone":
          return this.#success(action, await this.#measure(() => this.#clone()));
        case "fetch":
          return this.#success(action, await this.#measure(() => this.#fetch()));
        case "mutate":
          return this.#success(action, await this.#measure(() => this.#mutate()));
        case "add":
          return this.#success(action, await this.#measure(() => this.#add()));
        case "commit":
          return this.#success(action, await this.#measure(() => this.#commit()));
        case "push":
          return this.#success(action, await this.#measure(() => this.#push()));
        case "rebase-clean":
          return this.#success(action, await this.#rebaseClean());
        case "rebase-continue-setup":
          return this.#success(action, await this.#rebaseSetup(REBASE_CONTINUE_DIR, "continue"));
        case "rebase-continue-status":
          return this.#success(
            action,
            await this.#measure(() => this.#rebaseStatus(REBASE_CONTINUE_DIR)),
          );
        case "rebase-continue-resolve":
          return this.#success(action, await this.#measure(() => this.#resolveRebase()));
        case "rebase-continue-finish":
          return this.#success(action, await this.#measure(() => this.#continueRebase()));
        case "rebase-abort-setup":
          return this.#success(action, await this.#rebaseSetup(REBASE_ABORT_DIR, "abort"));
        case "rebase-abort-status":
          return this.#success(
            action,
            await this.#measure(() => this.#rebaseStatus(REBASE_ABORT_DIR)),
          );
        case "rebase-abort-finish":
          return this.#success(action, await this.#measure(() => this.#abortRebase()));
        case "marker-set":
          return this.#success(action, await this.#measure(() => this.#setMarker()));
        case "marker-state":
          return this.#success(action, await this.#measure(() => this.#markerState()));
        case "audit":
          return this.#success(action, await this.#measure(() => this.#audit()));
        default:
          return checkedResponse({ ok: false, error: `unknown action ${action}` }, 404);
      }
    } catch (error) {
      return this.#failure(action, error);
    }
  }

  #initializeProbeTables(): void {
    this.#storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS probe_instance_events (
         ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
         instance_id TEXT NOT NULL,
         foreign_keys_before INTEGER NOT NULL,
         foreign_keys_after INTEGER NOT NULL,
         created_at INTEGER NOT NULL
       )`,
    );
    this.#storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS probe_facts (
         name TEXT PRIMARY KEY,
         value TEXT NOT NULL
       ) WITHOUT ROWID`,
    );
  }

  #setFact(name: string, value: string): void {
    this.#storage.sql.exec(
      `INSERT INTO probe_facts (name, value) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
      name,
      value,
    );
  }

  #getFact(name: string): string | undefined {
    const row = this.#storage.sql
      .exec<FactRow>("SELECT value FROM probe_facts WHERE name = ?", name)
      .toArray()[0];
    if (row === undefined) return undefined;
    if (typeof row.value !== "string") throw new Error(`probe fact ${name} is invalid`);
    return row.value;
  }

  async #measure(operation: () => unknown | Promise<unknown>): Promise<OperationResult> {
    this.#counting.sql.reset();
    const facts = await operation();
    const metrics = probeMetrics(this.#counting.sql.statements, this.#counting.sql.rows);
    return { metrics, facts };
  }

  #success(action: string, result: OperationResult): Response {
    const value = {
      ok: true,
      action,
      instanceId: this.#instanceId,
      constructorOrdinal: this.#constructorOrdinal,
      foreignKeysBefore: this.#foreignKeysBefore,
      foreignKeysAfter: this.#foreignKeysAfter,
      databaseBytes: databaseBytes(this.#storage),
      metrics: result.metrics,
      facts: result.facts,
    };
    console.log(JSON.stringify({ event: "production-probe", ...value }));
    return checkedResponse(value);
  }

  #failure(action: string, error: unknown): Response {
    const value = {
      ok: false,
      action,
      instanceId: this.#instanceId,
      constructorOrdinal: this.#constructorOrdinal,
      error: errorMessage(error),
      code: errorCode(error),
      metrics: probeMetrics(this.#counting.sql.statements, this.#counting.sql.rows),
    };
    console.error(JSON.stringify({ event: "production-probe-failure", ...value }));
    return checkedResponse(value, 500);
  }

  async #clone(): Promise<unknown> {
    await this.#workspace.git.clone({
      url: PROBE_FIXTURE_URL,
      dir: PRIMARY_DIR,
      ref: PROBE_FIXTURE_BRANCH,
      depth: 1,
      singleBranch: true,
      noTags: true,
    });
    const head = await this.#workspace.git.revParse({ dir: PRIMARY_DIR, ref: "HEAD" });
    const files = await this.#workspace.git.lsFiles({ dir: PRIMARY_DIR });
    if (head !== PROBE_FIXTURE_HEAD) throw new Error("clone HEAD does not match pinned fixture");
    if (files.length !== 1 || files[0] !== "README") {
      throw new Error("clone worktree does not match pinned fixture");
    }
    return { head, files };
  }

  async #fetch(): Promise<unknown> {
    const result = await this.#workspace.git.fetch({
      dir: PRIMARY_DIR,
      remoteRef: PROBE_FIXTURE_FETCH_BRANCH,
      depth: 1,
      singleBranch: true,
      tags: false,
    });
    if (result.fetchHead !== PROBE_FIXTURE_FETCH_HEAD) {
      throw new Error("fetch HEAD does not match pinned fixture");
    }
    const fetched = await this.#workspace.git.revParse({
      dir: PRIMARY_DIR,
      ref: `refs/remotes/origin/${PROBE_FIXTURE_FETCH_BRANCH}`,
    });
    if (fetched !== PROBE_FIXTURE_FETCH_HEAD) throw new Error("fetch ref was not published");
    return { ...result, fetched };
  }

  #mutate(): unknown {
    const path = `${PRIMARY_DIR}/probe.txt`;
    this.#workspace.fs.writeFileSync(path, "production Durable Object\n", "utf8");
    const content = this.#workspace.fs.readFileSync(path, "utf8");
    if (content !== "production Durable Object\n") throw new Error("worktree mutation mismatch");
    return { path, bytes: utf8.encode(content).length };
  }

  async #add(): Promise<unknown> {
    await this.#workspace.git.add({ dir: PRIMARY_DIR, paths: ["probe.txt"] });
    const status = await this.#workspace.git.status({ dir: PRIMARY_DIR });
    if (status.length !== 1 || status[0]?.path !== "probe.txt" || status[0].index !== "A") {
      throw new Error("add did not stage probe.txt");
    }
    return { status };
  }

  async #commit(): Promise<unknown> {
    const parent = await this.#workspace.git.revParse({ dir: PRIMARY_DIR, ref: "HEAD" });
    const result = await this.#workspace.git.commit({
      dir: PRIMARY_DIR,
      message: "production probe",
    });
    const head = await this.#workspace.git.revParse({ dir: PRIMARY_DIR, ref: "HEAD" });
    const status = await this.#workspace.git.status({ dir: PRIMARY_DIR });
    if (head !== result.oid || head === parent || status.length !== 0) {
      throw new Error("commit postcondition failed");
    }
    return { parent, head, status };
  }

  async #push(): Promise<unknown> {
    const head = await this.#workspace.git.revParse({ dir: PRIMARY_DIR, ref: "HEAD" });
    const result = await this.#workspace.git.push({ dir: PRIMARY_DIR, url: PUSH_URL });
    if (!result.ok || this.#receiver.newOid !== head || this.#receiver.packOffset < 0) {
      throw new Error("push transport did not receive the committed pack");
    }
    return {
      result,
      head,
      receivedBytes: this.#receiver.receivedBytes,
      packOffset: this.#receiver.packOffset,
    };
  }

  async #commitFile(dir: string, path: string, content: string, message: string): Promise<string> {
    this.#workspace.fs.writeFileSync(`${dir}/${path}`, content, "utf8");
    await this.#workspace.git.add({ dir, paths: [path] });
    return (await this.#workspace.git.commit({ dir, message })).oid;
  }

  async #rebaseClean(): Promise<OperationResult> {
    this.#workspace.fs.mkdirSync(REBASE_CLEAN_DIR, { recursive: true });
    await this.#workspace.git.init({ dir: REBASE_CLEAN_DIR, defaultBranch: "main" });
    await this.#commitFile(REBASE_CLEAN_DIR, "base.txt", "base\n", "base");
    await this.#workspace.git.branch({ dir: REBASE_CLEAN_DIR, name: "upstream" });
    await this.#workspace.git.checkout({ dir: REBASE_CLEAN_DIR, ref: "upstream" });
    const upstream = await this.#commitFile(
      REBASE_CLEAN_DIR,
      "upstream.txt",
      "upstream\n",
      "upstream",
    );
    await this.#workspace.git.checkout({ dir: REBASE_CLEAN_DIR, ref: "main" });
    const original = await this.#commitFile(
      REBASE_CLEAN_DIR,
      "current.txt",
      "current\n",
      "current",
    );
    return this.#measure(async () => {
      const result = await this.#workspace.git.rebase({
        dir: REBASE_CLEAN_DIR,
        upstream: "upstream",
      });
      const head = await this.#workspace.git.revParse({ dir: REBASE_CLEAN_DIR, ref: "HEAD" });
      const status = await this.#workspace.git.status({ dir: REBASE_CLEAN_DIR });
      if (result.outcome !== "completed" || head === original || status.length !== 0) {
        throw new Error("clean rebase postcondition failed");
      }
      return { result, original, upstream, head, status };
    });
  }

  async #rebaseSetup(dir: string, factPrefix: string): Promise<OperationResult> {
    this.#workspace.fs.mkdirSync(dir, { recursive: true });
    await this.#workspace.git.init({ dir, defaultBranch: "main" });
    await this.#commitFile(dir, "shared.txt", "base\n", "base");
    await this.#workspace.git.branch({ dir, name: "upstream" });
    await this.#workspace.git.checkout({ dir, ref: "upstream" });
    const upstream = await this.#commitFile(dir, "shared.txt", "upstream\n", "upstream");
    await this.#workspace.git.checkout({ dir, ref: "main" });
    const original = await this.#commitFile(dir, "shared.txt", "current\n", "current");
    this.#setFact(`${factPrefix}:original`, original);
    this.#setFact(`${factPrefix}:upstream`, upstream);
    return this.#measure(async () => {
      const result = await this.#workspace.git.rebase({ dir, upstream: "upstream" });
      const status = await this.#workspace.git.status({ dir });
      if (
        result.outcome !== "conflicted" ||
        status.length !== 1 ||
        status[0]?.path !== "shared.txt" ||
        status[0].index !== "U"
      ) {
        throw new Error("conflicted rebase did not retain expected state");
      }
      return { result, original, upstream, status };
    });
  }

  async #rebaseStatus(dir: string): Promise<unknown> {
    const status = await this.#workspace.git.status({ dir });
    const head = await this.#workspace.git.revParse({ dir, ref: "HEAD" });
    if (status.length !== 1 || status[0]?.path !== "shared.txt" || status[0].index !== "U") {
      throw new Error("reopened rebase state is not conflicted");
    }
    return { head, status };
  }

  async #resolveRebase(): Promise<unknown> {
    this.#workspace.fs.writeFileSync(`${REBASE_CONTINUE_DIR}/shared.txt`, "resolved\n", "utf8");
    await this.#workspace.git.add({ dir: REBASE_CONTINUE_DIR, paths: ["shared.txt"] });
    const status = await this.#workspace.git.status({ dir: REBASE_CONTINUE_DIR });
    if (status.some((entry) => entry.index === "U" || entry.worktree === "U")) {
      throw new Error("rebase resolution left an unmerged entry");
    }
    return { status };
  }

  async #continueRebase(): Promise<unknown> {
    const original = this.#getFact("continue:original");
    if (original === undefined) throw new Error("continue original HEAD fact is missing");
    const result = await this.#workspace.git.rebaseContinue({ dir: REBASE_CONTINUE_DIR });
    const head = await this.#workspace.git.revParse({ dir: REBASE_CONTINUE_DIR, ref: "HEAD" });
    const status = await this.#workspace.git.status({ dir: REBASE_CONTINUE_DIR });
    const content = this.#workspace.fs.readFileSync(`${REBASE_CONTINUE_DIR}/shared.txt`, "utf8");
    if (
      result.outcome !== "completed" ||
      head === original ||
      status.length !== 0 ||
      content !== "resolved\n"
    ) {
      throw new Error("rebase continue postcondition failed");
    }
    return { result, original, head, status, content };
  }

  async #abortRebase(): Promise<unknown> {
    const original = this.#getFact("abort:original");
    if (original === undefined) throw new Error("abort original HEAD fact is missing");
    await this.#workspace.git.rebaseAbort({ dir: REBASE_ABORT_DIR });
    const head = await this.#workspace.git.revParse({ dir: REBASE_ABORT_DIR, ref: "HEAD" });
    const status = await this.#workspace.git.status({ dir: REBASE_ABORT_DIR });
    const content = this.#workspace.fs.readFileSync(`${REBASE_ABORT_DIR}/shared.txt`, "utf8");
    if (head !== original || status.length !== 0 || content !== "current\n") {
      throw new Error("rebase abort postcondition failed");
    }
    return { original, head, status, content };
  }

  #setMarker(): unknown {
    this.#setFact("storage-marker", "present");
    return { marker: "present" };
  }

  #markerState(): unknown {
    return { marker: this.#getFact("storage-marker") ?? null };
  }

  async #audit(): Promise<unknown> {
    const quick = this.#storage.sql.exec<CheckRow>("PRAGMA quick_check").toArray();
    if (quick.length !== 1 || quick[0]?.quick_check !== "ok") {
      throw new Error("SQLite quick_check did not return ok");
    }
    const foreignKeyRows = this.#storage.sql.exec("PRAGMA foreign_key_check").toArray();
    if (foreignKeyRows.length !== 0) throw new Error("SQLite foreign_key_check found violations");
    const pendingRow = this.#storage.sql
      .exec<CountRow>("SELECT count(*) AS count FROM git_pack_meta WHERE state = 'pending'")
      .toArray()[0];
    const operationRow = this.#storage.sql
      .exec<CountRow>("SELECT count(*) AS count FROM git_operation_state")
      .toArray()[0];
    const pendingPacks = nonnegativeInteger(pendingRow?.count, "pending pack count");
    const operationStates = nonnegativeInteger(operationRow?.count, "operation state count");
    if (pendingPacks !== 0 || operationStates !== 0) {
      throw new Error("repository audit found incomplete durable state");
    }
    const repositories = [PRIMARY_DIR, REBASE_CLEAN_DIR, REBASE_CONTINUE_DIR, REBASE_ABORT_DIR];
    const heads: Record<string, string> = {};
    for (const dir of repositories) {
      heads[dir] = await this.#workspace.git.revParse({ dir, ref: "HEAD" });
      const status = await this.#workspace.git.status({ dir });
      if (status.length !== 0) throw new Error(`${dir} is dirty after the production probe`);
    }
    return {
      quickCheck: "ok",
      foreignKeyViolations: foreignKeyRows.length,
      foreignKeys: pragmaForeignKeys(this.#storage.sql),
      pendingPacks,
      operationStates,
      heads,
      databaseBytes: databaseBytes(this.#storage),
    };
  }
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) return undefined;
  return authorization.slice("Bearer ".length);
}

function workerMetadata(request: Request): { colo: string | null; country: string | null } {
  const cf = Reflect.get(request, "cf");
  if (typeof cf !== "object" || cf === null) return { colo: null, country: null };
  const colo = Reflect.get(cf, "colo");
  const country = Reflect.get(cf, "country");
  return {
    colo: typeof colo === "string" ? colo : null,
    country: typeof country === "string" ? country : null,
  };
}

async function workerFetch(request: Request, env: WorkerEnv): Promise<Response> {
  if (env.PROBE_TOKEN.length < 32) {
    return checkedResponse({ ok: false, error: "PROBE_TOKEN is not configured" }, 503);
  }
  if (bearerToken(request) !== env.PROBE_TOKEN) {
    return checkedResponse({ ok: false, error: "unauthorized" }, 401);
  }
  const parts = new URL(request.url).pathname.split("/").filter((part) => part !== "");
  const runId = parts[0] === "runs" ? parts[1] : undefined;
  const action = parts.slice(2).join("-");
  if (runId === undefined || !RUN_ID.test(runId) || action === "") {
    return checkedResponse({ ok: false, error: "invalid probe path" }, 404);
  }
  const stub = env.PROBE.getByName(runId);
  const response = await stub.fetch(
    new Request(`https://probe.invalid/${action}`, { method: "POST" }),
  );
  const headers = new Headers(response.headers);
  const metadata = workerMetadata(request);
  headers.set("cache-control", "no-store");
  headers.set("x-probe-version", env.CF_VERSION_METADATA.id);
  headers.set("x-probe-colo", metadata.colo ?? "unknown");
  headers.set("x-probe-country", metadata.country ?? "unknown");
  return new Response(response.body, { status: response.status, headers });
}

export default { fetch: workerFetch };
