import {
  createGitServer,
  Database,
  type DurableObjectStorageLike,
  type GitServer,
  maintainRepository,
  SqliteGitDatabase,
} from "@kompjutr/do";

export interface RepositoryStorage extends DurableObjectStorageLike {
  setAlarm(timestamp: number): Promise<void>;
  getAlarm(): Promise<number | null>;
}

export interface RepositoryContext {
  storage: RepositoryStorage;
}

export class GitRepository {
  readonly database: SqliteGitDatabase;
  readonly repoId: number;
  readonly server: GitServer;
  #alarmScheduling: Promise<void> = Promise.resolve();

  constructor(readonly context: RepositoryContext) {
    const db = new Database(context.storage);
    this.database = new SqliteGitDatabase(db);
    this.repoId = db.transactionSync(() => {
      db.run(`CREATE TABLE IF NOT EXISTS server_repository (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        repo_id INTEGER NOT NULL
      )`);
      const existing = db.scalar<number>(
        "SELECT repo_id FROM server_repository WHERE singleton = 1",
      );
      if (existing !== undefined) return existing;
      const repository = this.database.createBareRepository("refs/heads/main");
      db.run("INSERT INTO server_repository VALUES (1, ?)", repository.repoId);
      return repository.repoId;
    });
    this.server = createGitServer(this.database.openBareRepository(this.repoId), {
      maxPackBytes: 256 * 1024 * 1024,
    });
  }

  async fetch(request: Request): Promise<Response> {
    // Persist a wake-up before serving: cancellation or eviction must not strand a transfer.
    await this.#scheduleAlarm(Date.now() + 60_000);
    return this.server.fetch(request);
  }

  #scheduleAlarm(deadline: number): Promise<void> {
    const scheduled = this.#alarmScheduling.then(async () => {
      const existing = await this.context.storage.getAlarm();
      if (existing === null || deadline < existing) await this.context.storage.setAlarm(deadline);
    });
    this.#alarmScheduling = scheduled.catch(() => {});
    return scheduled;
  }

  async alarm(): Promise<void> {
    for (let step = 0; step < 32; step++) {
      const result = maintainRepository(this.database, this.repoId, { nowMs: Date.now() });
      if (result.status === "complete") {
        if (result.nextEligibleAt !== null) {
          await this.#scheduleAlarm(Math.max(Date.now() + 1_000, result.nextEligibleAt));
        }
        return;
      }
    }
    await this.#scheduleAlarm(Date.now() + 1_000);
  }
}

interface RepositoryStub {
  fetch(request: Request): Promise<Response>;
}

export interface ServerEnvironment {
  REPOSITORIES: { getByName(name: string): RepositoryStub };
  GIT_READ_TOKEN: string;
  GIT_WRITE_TOKEN: string;
}

function credential(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    return separator < 0 ? null : decoded.slice(separator + 1);
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: ServerEnvironment): Promise<Response> {
    const url = new URL(request.url);
    const match =
      /^\/([a-z0-9][a-z0-9-]{0,62})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
        url.pathname,
      );
    if (match === null) return new Response("not found", { status: 404 });
    const name = match[1];
    const endpoint = match[2];
    if (name === undefined || endpoint === undefined)
      return new Response("not found", { status: 404 });
    const service = endpoint === "info/refs" ? url.searchParams.get("service") : endpoint;
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      return new Response("unsupported service", { status: 400 });
    }
    const token = credential(request);
    const write = token !== null && env.GIT_WRITE_TOKEN.length > 0 && token === env.GIT_WRITE_TOKEN;
    const read = token !== null && env.GIT_READ_TOKEN.length > 0 && token === env.GIT_READ_TOKEN;
    if (!write && !(read && service === "git-upload-pack")) {
      return new Response("authentication required", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="Git", charset="UTF-8"' },
      });
    }
    url.pathname = `/${endpoint}`;
    return env.REPOSITORIES.getByName(name).fetch(new Request(url, request));
  },
};
