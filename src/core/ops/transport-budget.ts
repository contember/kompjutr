import type { MemoryReservation } from "../../memory.js";
import { GitError } from "../errors.js";

function invalidCount(label: string): GitError {
  return new GitError("EINVAL", `${label} must be a safe nonnegative integer`);
}

/** Named transport portions backed by one caller-owned operation reservation. */
export class TransportOperationBudget {
  readonly #memory = new Map<string, number>();
  #retainedBytes = 0;

  constructor(private readonly reservation: MemoryReservation) {}

  get retainedBytes(): number {
    return this.#retainedBytes;
  }

  /** Exact capacity left across every owner sharing the operation coordinator. */
  get remainingMemoryBytes(): number {
    return this.reservation.remainingBytes;
  }

  /** Create an independently disposable scope under the transport operation. */
  scopeMemory(): MemoryReservation {
    return this.reservation.scope();
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
    if (bytes > Number.MAX_SAFE_INTEGER - withoutPrevious) {
      throw invalidCount("transport memory bytes");
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
}
