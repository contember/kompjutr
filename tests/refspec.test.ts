import { describe, expect, it } from "vitest";

import {
  compileFetchRefspecs,
  compilePushRefspecs,
  MAX_REFSPEC_EXPANDED_DESTINATIONS,
  MAX_REFSPEC_MAPPINGS,
  MAX_REFSPEC_REF_BYTES,
  type PushRefspec,
  type RefspecSourceRef,
} from "../src/core/ops/refspec.js";
import {
  MAX_TRANSPORT_MEMORY_BYTES,
  TransportOperationBudget,
} from "../src/core/ops/transport-budget.js";
import { MemoryCoordinator } from "../src/memory.js";
import { requireRefName } from "../src/sqlite/ref-validation.js";

const OID = "1".repeat(40);

function fixture(): {
  readonly coordinator: MemoryCoordinator;
  readonly reservation: ReturnType<MemoryCoordinator["reserve"]>;
  readonly budget: TransportOperationBudget;
} {
  const coordinator = new MemoryCoordinator();
  const reservation = coordinator.reserve();
  return { coordinator, reservation, budget: new TransportOperationBudget(reservation) };
}

function expectCode(run: () => unknown, code: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
}

describe("structured refspecs", () => {
  it("rejects an empty input list before retaining compiled state", () => {
    const { coordinator, reservation, budget } = fixture();
    expectCode(() => compileFetchRefspecs([], budget), "EINVAL");
    expect(budget.retainedBytes).toBe(0);
    reservation.dispose();
    coordinator.assertIdle();
  });

  it("expands exact and wildcard fetch mappings in Git UTF-8 destination order", () => {
    const { coordinator, reservation, budget } = fixture();
    const compiled = compileFetchRefspecs(
      [
        { source: "refs/heads/main", destination: "refs/local/main" },
        { source: "refs/source/*", destination: "refs/destination/*", force: true },
      ],
      budget,
    );
    const expanded = compiled.expand([
      { name: "HEAD", oid: OID },
      { name: "refs/tags/v1^{}", oid: "2".repeat(40) },
      { name: "refs/source/\u{1f600}", oid: "3".repeat(40) },
      { name: "refs/heads/main", oid: "4".repeat(40) },
      { name: "refs/source/\ue000", oid: "5".repeat(40) },
    ]);

    expect(expanded).toEqual([
      {
        source: "refs/source/\ue000",
        destination: "refs/destination/\ue000",
        oid: "5".repeat(40),
        force: true,
      },
      {
        source: "refs/source/\u{1f600}",
        destination: "refs/destination/\u{1f600}",
        oid: "3".repeat(40),
        force: true,
      },
      {
        source: "refs/heads/main",
        destination: "refs/local/main",
        oid: "4".repeat(40),
        force: false,
      },
    ]);
    expect(budget.retainedBytes).toBeGreaterThan(0);
    compiled.dispose();
    expect(budget.retainedBytes).toBe(0);
    reservation.dispose();
    coordinator.assertIdle();
  });

  it("keeps an empty wildcard empty and combines it with nonempty mappings", () => {
    const { coordinator, reservation, budget } = fixture();
    const compiled = compilePushRefspecs(
      [
        { source: "refs/missing/*", destination: "refs/remote/missing/*" },
        { source: "refs/heads/main", destination: "refs/heads/main" },
      ],
      budget,
    );
    expect(compiled.expand([{ name: "refs/heads/main", oid: OID }])).toEqual([
      {
        source: "refs/heads/main",
        destination: "refs/heads/main",
        oid: OID,
        force: false,
      },
    ]);
    compiled.dispose();
    reservation.dispose();
    coordinator.assertIdle();
  });

  it("supports push oid sources and deletions without wildcarding them", () => {
    const { coordinator, reservation, budget } = fixture();
    const oid = "a".repeat(40);
    const compiled = compilePushRefspecs(
      [
        { source: oid, destination: "refs/checkpoints/exact", force: true },
        { source: null, destination: "refs/heads/old" },
      ],
      budget,
    );
    expect(compiled.expand([])).toEqual([
      {
        source: oid,
        destination: "refs/checkpoints/exact",
        oid,
        force: true,
      },
      {
        source: null,
        destination: "refs/heads/old",
        oid: null,
        force: false,
      },
    ]);
    compiled.dispose();
    reservation.dispose();
    coordinator.assertIdle();
  });

  it("rejects runtime deletion force and wildcarded deletion or oid destinations", () => {
    const { coordinator, reservation, budget } = fixture();
    const forcedDeletion: PushRefspec = {
      source: null,
      destination: "refs/heads/old",
    };
    Object.defineProperty(forcedDeletion, "force", { value: true });
    expectCode(() => compilePushRefspecs([forcedDeletion], budget), "EINVAL");
    expectCode(
      () => compilePushRefspecs([{ source: null, destination: "refs/heads/*" }], budget),
      "EINVAL",
    );
    expectCode(
      () =>
        compilePushRefspecs(
          [{ source: "a".repeat(40), destination: "refs/checkpoints/*" }],
          budget,
        ),
      "EINVAL",
    );
    expect(budget.retainedBytes).toBe(0);
    reservation.dispose();
    coordinator.assertIdle();
  });

  it("rejects malformed wildcard placement, invalid refs, and oversized refs", () => {
    const cases: readonly (readonly [{ source: string; destination: string }, string])[] = [
      [{ source: "refs/source/*", destination: "refs/destination/exact" }, "EINVAL"],
      [{ source: "refs/source/**", destination: "refs/destination/*" }, "EINVAL"],
      [{ source: "source/main", destination: "refs/destination/main" }, "EINVALIDREF"],
      [{ source: "refs/source/main", destination: "refs/destination/.hidden" }, "EINVALIDREF"],
    ];
    for (const [refspec, code] of cases) {
      const { coordinator, reservation, budget } = fixture();
      expectCode(() => compileFetchRefspecs([refspec], budget), code);
      expect(budget.retainedBytes).toBe(0);
      reservation.dispose();
      coordinator.assertIdle();
    }

    const prefix = "refs/heads/";
    const exact = `${prefix}${"a".repeat(MAX_REFSPEC_REF_BYTES - prefix.length)}`;
    const { coordinator, reservation, budget } = fixture();
    const compiled = compileFetchRefspecs([{ source: exact, destination: exact }], budget);
    compiled.dispose();
    expectCode(
      () => compileFetchRefspecs([{ source: `${exact}a`, destination: exact }], budget),
      "E2BIG",
    );
    reservation.dispose();
    coordinator.assertIdle();
  });

  it("accepts a 1,024-byte wildcard pattern and rejects its first byte excess", () => {
    const prefix = "refs/source/";
    const pattern = `${prefix}${"a".repeat(MAX_REFSPEC_REF_BYTES - prefix.length - 1)}*`;
    const { coordinator, reservation, budget } = fixture();
    const compiled = compileFetchRefspecs(
      [{ source: pattern, destination: "refs/destination/*" }],
      budget,
    );
    compiled.dispose();
    expectCode(
      () =>
        compileFetchRefspecs(
          [{ source: `${pattern}a`, destination: "refs/destination/*" }],
          budget,
        ),
      "E2BIG",
    );
    expect(budget.retainedBytes).toBe(0);
    reservation.dispose();
    coordinator.assertIdle();
  });

  it("rejects exact duplicates before expansion and wildcard collisions during expansion", () => {
    const first = fixture();
    expectCode(
      () =>
        compileFetchRefspecs(
          [
            { source: "refs/heads/a", destination: "refs/local/same" },
            { source: "refs/heads/b", destination: "refs/local/same" },
          ],
          first.budget,
        ),
      "EINVAL",
    );
    expect(first.budget.retainedBytes).toBe(0);
    first.reservation.dispose();
    first.coordinator.assertIdle();

    const second = fixture();
    const fetch = compileFetchRefspecs(
      [
        { source: "refs/heads/a", destination: "refs/local/a" },
        { source: "refs/source/*", destination: "refs/local/*" },
      ],
      second.budget,
    );
    expectCode(
      () =>
        fetch.expand([
          { name: "refs/heads/a", oid: OID },
          { name: "refs/source/a", oid: "2".repeat(40) },
        ]),
      "EINVAL",
    );
    expect(second.budget.memory("refspec-expanded")).toBe(0);
    fetch.dispose();
    second.reservation.dispose();
    second.coordinator.assertIdle();

    const third = fixture();
    const push = compilePushRefspecs(
      [
        { source: "refs/heads/a", destination: "refs/remote/a" },
        { source: "refs/source/*", destination: "refs/remote/*" },
      ],
      third.budget,
    );
    expectCode(
      () =>
        push.expand([
          { name: "refs/heads/a", oid: OID },
          { name: "refs/source/a", oid: "2".repeat(40) },
        ]),
      "EINVAL",
    );
    push.dispose();
    third.reservation.dispose();
    third.coordinator.assertIdle();
  });

  it("fails a mixed set when an exact source is missing", () => {
    const { coordinator, reservation, budget } = fixture();
    const compiled = compilePushRefspecs(
      [
        { source: "refs/source/*", destination: "refs/remote/*" },
        { source: "refs/heads/missing", destination: "refs/heads/missing" },
      ],
      budget,
    );
    expectCode(() => compiled.expand([{ name: "refs/source/a", oid: OID }]), "EREFNOTFOUND");
    expect(budget.memory("refspec-expanded")).toBe(0);
    compiled.dispose();
    reservation.dispose();
    coordinator.assertIdle();
  });

  it("accepts exact mapping and expansion caps and rejects their first excess", () => {
    const source: RefspecSourceRef = { name: "refs/heads/source", oid: OID };
    const exactMappings = Array.from({ length: MAX_REFSPEC_MAPPINGS }, (_, index) => ({
      source: source.name,
      destination: `refs/destination/${index.toString().padStart(4, "0")}`,
    }));
    const exact = fixture();
    const compiled = compileFetchRefspecs(exactMappings, exact.budget);
    expect(compiled.expand([source])).toHaveLength(MAX_REFSPEC_EXPANDED_DESTINATIONS);
    compiled.dispose();
    exact.reservation.dispose();
    exact.coordinator.assertIdle();

    const inputExcess = fixture();
    expectCode(
      () =>
        compileFetchRefspecs(
          [...exactMappings, { source: source.name, destination: "refs/destination/excess" }],
          inputExcess.budget,
        ),
      "E2BIG",
    );
    expect(inputExcess.budget.retainedBytes).toBe(0);
    inputExcess.reservation.dispose();
    inputExcess.coordinator.assertIdle();

    const expansionExcess = fixture();
    const wildcard = compileFetchRefspecs(
      [{ source: "refs/source/*", destination: "refs/destination/*" }],
      expansionExcess.budget,
    );
    const sources = Array.from({ length: MAX_REFSPEC_EXPANDED_DESTINATIONS + 1 }, (_, index) => ({
      name: `refs/source/${index}`,
      oid: OID,
    }));
    expectCode(() => wildcard.expand(sources), "E2BIG");
    expect(expansionExcess.budget.memory("refspec-expanded")).toBe(0);
    wildcard.dispose();
    expansionExcess.reservation.dispose();
    expansionExcess.coordinator.assertIdle();
  });

  it("rejects the first expanded destination byte excess", () => {
    const { coordinator, reservation, budget } = fixture();
    const compiled = compileFetchRefspecs(
      [{ source: "refs/*", destination: "refs/destination/*" }],
      budget,
    );
    const sourcePrefix = "refs/";
    const name = `${sourcePrefix}${"a".repeat(MAX_REFSPEC_REF_BYTES - sourcePrefix.length)}`;
    expectCode(() => compiled.expand([{ name, oid: OID }]), "E2BIG");
    compiled.dispose();
    reservation.dispose();
    coordinator.assertIdle();
  });

  it("keeps stored-ref acceptance and caller-specific errors unchanged", () => {
    expect(requireRefName("main", "stored ref", "stored")).toBe("main");
    expect(requireRefName("refs/heads/main", "stored ref", "stored")).toBe("refs/heads/main");
    expectCode(() => requireRefName("refs/heads/.hidden", "stored ref", "stored"), "ECORRUPT");
    expectCode(() => requireRefName("refs/heads/.hidden", "input ref", "input"), "EINVAL");
    expectCode(
      () =>
        requireRefName(`refs/heads/${"a".repeat(MAX_REFSPEC_REF_BYTES)}`, "stored ref", "stored"),
      "ECORRUPT",
    );
  });
});

describe("transport operation budget", () => {
  it("composes named memory against one 64 MiB operation reservation", () => {
    const { coordinator, reservation, budget } = fixture();
    budget.setMemory("compiled", MAX_TRANSPORT_MEMORY_BYTES - 1);
    budget.setMemory("expanded", 1);
    expect(budget.retainedBytes).toBe(MAX_TRANSPORT_MEMORY_BYTES);
    expectCode(() => budget.setMemory("expanded", 2), "E2BIG");
    expect(budget.retainedBytes).toBe(MAX_TRANSPORT_MEMORY_BYTES);
    budget.clearAllMemory();

    reservation.set("other", 1);
    expectCode(() => budget.setMemory("protocol", MAX_TRANSPORT_MEMORY_BYTES), "E2BIG");
    expect(budget.retainedBytes).toBe(0);
    reservation.clear("other");
    reservation.dispose();
    coordinator.assertIdle();
  });
});
