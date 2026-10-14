import { createGitServer, Database, maintainRepository } from "@kompjutr/do";
import example, {
  GitRepository,
  type RepositoryContext,
  type ServerEnvironment,
} from "../../examples/git-server/worker.js";
import { GC_DONE_MARKER } from "../workerd/protocol.js";
import { CountedStorage, type SqlCounts } from "./storage.js";
import { transferState } from "./transfer-state.js";

interface PhaseCounters {
  phase: string | null;
  generations: number;
  totals: SqlCounts;
}

// DO eviction must not discard a measured phase; an isolate restart loses its epoch.
const countersByObject = new Map<string, PhaseCounters>();

export class ServerBench extends GitRepository {
  readonly counts: CountedStorage;
  readonly measuredServer;
  readonly phaseCounters: PhaseCounters;
  constructor(
    context: RepositoryContext & { id: { toString(): string } },
    env: { BENCH_MARKER_URL: string },
  ) {
    const key = context.id.toString();
    let phaseCounters = countersByObject.get(key);
    if (phaseCounters === undefined) {
      phaseCounters = { phase: null, generations: 0, totals: { statements: 0, returnedRows: 0 } };
      countersByObject.set(key, phaseCounters);
    }
    phaseCounters.generations++;
    const counts = new CountedStorage(context.storage, phaseCounters.totals);
    super({
      storage: {
        sql: counts.sql,
        transactionSync: (closure) => counts.transactionSync(closure),
        setAlarm: (time) => context.storage.setAlarm(time),
        getAlarm: () => context.storage.getAlarm(),
      },
    });
    this.counts = counts;
    this.phaseCounters = phaseCounters;
    this.measuredServer = createGitServer(this.database.openBareRepository(this.repoId), {
      maxPackBytes: 256 * 1024 * 1024,
      yieldNow: async () => {
        const response = await fetch(env.BENCH_MARKER_URL);
        if (!response.ok) throw new Error("host CPU checkpoint failed");
        await response.text();
      },
    });
  }
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/__bench/reset") {
      const phase = url.searchParams.get("phase");
      if (phase === null || !/^[a-zA-Z0-9-]{1,64}$/.test(phase))
        return new Response("invalid phase epoch", { status: 400 });
      this.counts.reset();
      this.phaseCounters.phase = phase;
      this.phaseCounters.generations = 1;
      return Response.json({ reset: true });
    }
    if (path === "/__bench/counts")
      return Response.json({
        ...this.counts.counts(),
        phase: this.phaseCounters.phase,
        generations: this.phaseCounters.generations,
      });
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
