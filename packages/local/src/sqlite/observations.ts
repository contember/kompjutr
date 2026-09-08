import { localError } from "../errors.js";
import type { NodeSqliteDatabase } from "./database.js";

const LEASE_SIZE = 1_000_000;

export class ObservationClock {
  readonly #database: NodeSqliteDatabase;
  #next = 0;
  #end = 0;

  constructor(database: NodeSqliteDatabase) {
    this.#database = database;
  }

  next(): number {
    if (this.#next === this.#end) {
      const lease = this.#database.leaseObservationRevisions(LEASE_SIZE);
      this.#next = lease.start;
      this.#end = lease.end;
    }
    const revision = this.#next;
    this.#next++;
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw localError("E2BIG", "observation revisions are exhausted");
    }
    return revision;
  }
}
