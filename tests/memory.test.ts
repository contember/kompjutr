import { describe, expect, it } from "vitest";

import {
  MAX_OPERATION_MEMORY_BYTES,
  MemoryCoordinator,
  type MemoryReservation,
} from "../src/memory.js";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return Reflect.get(error, "code") === undefined ? undefined : String(Reflect.get(error, "code"));
}

function requiredReservation(value: MemoryReservation | undefined): MemoryReservation {
  if (value === undefined) throw new Error("test did not capture a reservation");
  return value;
}

describe("MemoryCoordinator", () => {
  it("admits exactly 64 MiB and rejects the next byte without mutation", () => {
    const coordinator = new MemoryCoordinator();
    const reservation = coordinator.reserve();
    expect(coordinator.remainingBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    expect(reservation.remainingBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    reservation.set("pool", MAX_OPERATION_MEMORY_BYTES);
    expect(reservation.currentBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    expect(coordinator.totalBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    expect(coordinator.remainingBytes).toBe(0);
    expect(reservation.remainingBytes).toBe(0);

    let thrown: unknown;
    try {
      reservation.set("other", 1);
    } catch (error) {
      thrown = error;
    }
    expect(errorCode(thrown)).toBe("E2BIG");
    expect(thrown).toMatchObject({
      name: "GitError",
      code: "E2BIG",
      message: `operation memory exceeds the ${MAX_OPERATION_MEMORY_BYTES}-byte limit`,
    });
    expect(reservation.currentBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    expect(reservation.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    expect(coordinator.totalBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    expect(coordinator.highWaterBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    reservation.dispose();
    coordinator.assertIdle();
  });

  it("enforces one aggregate cap across interleaved operations", () => {
    const coordinator = new MemoryCoordinator();
    const first = coordinator.reserve();
    const second = coordinator.reserve();
    first.set("base", 40 * 1024 * 1024);
    second.set("compressed", 24 * 1024 * 1024);
    expect(coordinator.totalBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    expect(coordinator.activeCount).toBe(2);

    expect(() => first.set("flat", 1)).toThrow(/64 MiB|67108864-byte/);
    expect(first.currentBytes).toBe(40 * 1024 * 1024);
    expect(second.currentBytes).toBe(24 * 1024 * 1024);
    expect(coordinator.totalBytes).toBe(MAX_OPERATION_MEMORY_BYTES);

    second.clear("compressed");
    first.set("flat", 1);
    expect(coordinator.totalBytes).toBe(40 * 1024 * 1024 + 1);
    first.dispose();
    second.dispose();
    coordinator.assertIdle();
  });

  it("clears and reuses fixed categories while preserving high-water marks", () => {
    const coordinator = new MemoryCoordinator();
    const reservation = coordinator.reserve();
    reservation.set("metadata", 100);
    reservation.set("tree", 200);
    expect(reservation.currentBytes).toBe(300);
    reservation.clear("metadata");
    reservation.set("commit", 50);
    expect(reservation.currentBytes).toBe(250);
    expect(reservation.highWaterBytes).toBe(300);
    expect(coordinator.highWaterBytes).toBe(300);
    expect(() => reservation.assertEmpty()).toThrow(/still owns bytes/);
    reservation.clear("tree");
    reservation.clear("commit");
    reservation.assertEmpty();
    expect(() => coordinator.assertIdle()).toThrow(/active reservations/);
    reservation.set("protocol", 25);
    expect(reservation.currentBytes).toBe(25);
    reservation.dispose();
    expect(reservation.currentBytes).toBe(0);
    expect(reservation.highWaterBytes).toBe(300);
    coordinator.assertIdle();
  });

  it("disposes once, releases all categories, and rejects captured reuse", () => {
    const coordinator = new MemoryCoordinator();
    let captured: MemoryReservation | undefined;
    const operation = (): void => {
      const reservation = coordinator.reserve();
      captured = reservation;
      reservation.set("pool", 10);
      reservation.set("packRow", 20);
      reservation.dispose();
      reservation.dispose();
    };
    operation();

    const reservation = requiredReservation(captured);
    expect(reservation.disposed).toBe(true);
    expect(reservation.currentBytes).toBe(0);
    reservation.assertEmpty();
    expect(() => reservation.set("pool", 1)).toThrow(/disposed/);
    expect(() => reservation.clear("pool")).toThrow(/disposed/);
    expect(coordinator.totalBytes).toBe(0);
    expect(coordinator.activeCount).toBe(0);
    coordinator.assertIdle();
  });

  it("rejects invalid byte counts before changing either account", () => {
    const invalid = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
    for (const bytes of invalid) {
      const coordinator = new MemoryCoordinator();
      const reservation = coordinator.reserve();
      reservation.set("other", 7);
      let thrown: unknown;
      try {
        reservation.set("other", bytes);
      } catch (error) {
        thrown = error;
      }
      expect(errorCode(thrown)).toBe("EINVAL");
      expect(reservation.currentBytes).toBe(7);
      expect(reservation.highWaterBytes).toBe(7);
      expect(coordinator.totalBytes).toBe(7);
      expect(coordinator.highWaterBytes).toBe(7);
      reservation.dispose();
      coordinator.assertIdle();
    }
  });

  it("does not accumulate coordinator state across 10,000 operations", () => {
    const coordinator = new MemoryCoordinator();
    for (let index = 0; index < 10_000; index++) {
      const reservation = coordinator.reserve();
      reservation.set("other", index % 17);
      reservation.dispose();
    }
    expect(coordinator.activeCount).toBe(0);
    expect(coordinator.totalBytes).toBe(0);
    expect(coordinator.highWaterBytes).toBe(16);
    coordinator.assertIdle();
  });

  it("accounts additive child scopes without overwriting sibling or parent categories", () => {
    const coordinator = new MemoryCoordinator();
    const owner = {};
    const root = coordinator.reserve(owner);
    root.set("other", 10);
    root.set("protocol", 20);
    const first = root.scope();
    const second = root.scope();
    first.set("other", 30);
    second.set("other", 40);

    expect(root.currentBytes).toBe(100);
    expect(first.currentBytes).toBe(30);
    expect(second.currentBytes).toBe(40);
    expect(coordinator.totalBytes).toBe(100);
    expect(coordinator.activeCount).toBe(1);

    first.dispose();
    expect(root.currentBytes).toBe(70);
    expect(second.currentBytes).toBe(40);
    expect(coordinator.totalBytes).toBe(70);
    root.clear("other");
    expect(root.currentBytes).toBe(60);
    root.clear("protocol");
    expect(root.currentBytes).toBe(40);

    root.dispose();
    expect(second.disposed).toBe(true);
    expect(() => second.set("other", 1)).toThrow(/disposed/);
    coordinator.assertIdle();
  });

  it("enforces the aggregate cap and coordinator provenance through child scopes", () => {
    const firstCoordinator = new MemoryCoordinator();
    const secondCoordinator = new MemoryCoordinator();
    const firstOwner = {};
    const secondOwner = {};
    const root = firstCoordinator.reserve(firstOwner);
    const child = root.scope();
    child.set("other", MAX_OPERATION_MEMORY_BYTES);

    expect(firstCoordinator.owns(root, firstOwner)).toBe(true);
    expect(firstCoordinator.owns(child, firstOwner)).toBe(true);
    expect(firstCoordinator.owns(child, secondOwner)).toBe(false);
    expect(secondCoordinator.owns(child, firstOwner)).toBe(false);
    expect(() => root.set("protocol", 1)).toThrowError(expect.objectContaining({ code: "E2BIG" }));
    expect(root.currentBytes).toBe(MAX_OPERATION_MEMORY_BYTES);
    expect(child.currentBytes).toBe(MAX_OPERATION_MEMORY_BYTES);

    child.dispose();
    expect(root.currentBytes).toBe(0);
    root.dispose();
    firstCoordinator.assertIdle();
    secondCoordinator.assertIdle();
  });
});
