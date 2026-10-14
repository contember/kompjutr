import { createGitServer, Database, maintainRepository } from "@kompjutr/do";
import example, {
  GitRepository,
  type RepositoryContext,
  type ServerEnvironment,
} from "../../examples/git-server/worker.js";
import { GC_DONE_MARKER } from "../workerd/protocol.js";
import { CountedStorage } from "./storage.js";
import { transferState } from "./transfer-state.js";

export class ServerBench extends GitRepository {
  readonly counts: CountedStorage;
  readonly measuredServer;
  constructor(context: RepositoryContext, env: { BENCH_MARKER_URL: string }) {
    const counts = new CountedStorage(context.storage);
    super({
      storage: {
        sql: counts.sql,
        transactionSync: (closure) => counts.transactionSync(closure),
        setAlarm: (time) => context.storage.setAlarm(time),
        getAlarm: () => context.storage.getAlarm(),
      },
    });
    this.counts = counts;
    this.measuredServer = createGitServer(this.database.openBareRepository(this.repoId), {
      maxPackBytes: 256 * 1024 * 1024,
      yieldNow: async () => {
        const response = await fetch(env.BENCH_MARKER_URL);
        if (!response.ok) throw new Error("host CPU checkpoint failed");
      },
    });
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__bench/reset") {
      this.counts.reset();
      return Response.json({ reset: true });
    }
    if (path === "/__bench/counts") return Response.json(this.counts.counts());
    if (path === "/__bench/gc") {
      const gc = Reflect.get(globalThis, "gc");
      if (typeof gc !== "function") throw new Error("missing exposed gc");
      Reflect.apply(gc, globalThis, []);
      console.log(GC_DONE_MARKER);
      return Response.json({ gc: true });
    }
    if (path === "/__bench/state")
      return Response.json(transferState(new Database(this.context.storage)));
    if (path === "/__bench/cleanup") {
      const db = new Database(this.context.storage);
      let steps = 0;
      while (steps++ < 100_000) {
        maintainRepository(this.database, this.repoId, { nowMs: Date.now() + 600_000 });
        const owners = db.scalar<number>("SELECT COUNT(*) FROM git_transfers");
        if (owners === 0)
          return Response.json({
            steps,
            owners,
            scratch: db.scalar<number>("SELECT COUNT(*) FROM git_transfer_objects"),
          });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("transfer cleanup did not finish");
    }
    return this.measuredServer.fetch(request);
  }
}

export default {
  fetch(request: Request, env: ServerEnvironment): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/__bench/")) {
      return env.REPOSITORIES.getByName("demo").fetch(request);
    }
    return example.fetch(request, env);
  },
};
