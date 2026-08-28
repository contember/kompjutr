import { MAX_OPERATION_MEMORY_BYTES, type MemoryReservation } from "../../sqlite/memory.js";
import { GitError } from "../errors.js";

export const MAX_TRANSPORT_MEMORY_BYTES = MAX_OPERATION_MEMORY_BYTES;
export const MAX_TRANSPORT_SQL_STATEMENTS = 1_000;

function invalidCount(label: string): GitError {
  return new GitError("EINVAL", `${label} must be a safe nonnegative integer`);
}

function sqlLimit(): GitError {
  return new GitError(
    "E2BIG",
    `transport operation exceeds the ${MAX_TRANSPORT_SQL_STATEMENTS}-statement SQL limit`,
  );
}

/** Named transport portions backed by one caller-owned operation reservation. */
export class TransportOperationBudget {
  readonly #memory = new Map<string, number>();
  readonly #sqlReservations = new Map<string, number>();
  #retainedBytes = 0;
  #sqlStatements = 0;
  #reservedSqlStatements = 0;

  constructor(private readonly reservation: MemoryReservation) {}

  get retainedBytes(): number {
    return this.#retainedBytes;
  }

  get sqlStatements(): number {
    return this.#sqlStatements;
  }

  get reservedSqlStatements(): number {
    return this.#reservedSqlStatements;
  }

  get remainingSqlStatements(): number {
    return MAX_TRANSPORT_SQL_STATEMENTS - this.#sqlStatements - this.#reservedSqlStatements;
  }

  memory(part: string): number {
    return this.#memory.get(part) ?? 0;
  }

  setMemory(part: string, bytes: number): void {
    if (part === "") throw new GitError("EINVAL", "transport memory part must not be empty");
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw invalidCount("transport memory bytes");
    }
    const previous = this.memory(part);
    if (previous === bytes) return;
    const withoutPrevious = this.#retainedBytes - previous;
    if (bytes > MAX_TRANSPORT_MEMORY_BYTES - withoutPrevious) {
      throw new GitError(
        "E2BIG",
        `transport operation exceeds the ${MAX_TRANSPORT_MEMORY_BYTES}-byte memory limit`,
      );
    }
    const next = withoutPrevious + bytes;
    this.reservation.set("protocol", next);
    if (bytes === 0) this.#memory.delete(part);
    else this.#memory.set(part, bytes);
    this.#retainedBytes = next;
  }

  clearMemory(part: string): void {
    this.setMemory(part, 0);
  }

  clearAllMemory(): void {
    this.reservation.clear("protocol");
    this.#memory.clear();
    this.#retainedBytes = 0;
  }

  chargeSql(statements = 1): void {
    if (!Number.isSafeInteger(statements) || statements < 0) {
      throw invalidCount("transport SQL statement count");
    }
    if (statements > this.remainingSqlStatements) throw sqlLimit();
    this.#sqlStatements += statements;
  }

  admitSql(statements: number): void {
    if (!Number.isSafeInteger(statements) || statements < 0) {
      throw invalidCount("transport SQL admission count");
    }
    if (statements > this.remainingSqlStatements) throw sqlLimit();
  }

  reserveSql(part: string, statements: number): void {
    if (part === "") throw new GitError("EINVAL", "transport SQL part must not be empty");
    if (!Number.isSafeInteger(statements) || statements < 0) {
      throw invalidCount("transport SQL reservation count");
    }
    const previous = this.#sqlReservations.get(part) ?? 0;
    const withoutPrevious = this.#reservedSqlStatements - previous;
    if (statements > MAX_TRANSPORT_SQL_STATEMENTS - this.#sqlStatements - withoutPrevious) {
      throw sqlLimit();
    }
    if (statements === 0) this.#sqlReservations.delete(part);
    else this.#sqlReservations.set(part, statements);
    this.#reservedSqlStatements = withoutPrevious + statements;
  }

  chargeReservedSql(part: string, statements = 1): void {
    if (!Number.isSafeInteger(statements) || statements < 0) {
      throw invalidCount("transport reserved SQL statement count");
    }
    const reserved = this.#sqlReservations.get(part) ?? 0;
    if (statements > reserved) throw sqlLimit();
    const remaining = reserved - statements;
    if (remaining === 0) this.#sqlReservations.delete(part);
    else this.#sqlReservations.set(part, remaining);
    this.#reservedSqlStatements -= statements;
    this.#sqlStatements += statements;
  }

  releaseSql(part: string): void {
    this.reserveSql(part, 0);
  }
}
