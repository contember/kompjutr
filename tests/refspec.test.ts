import { describe, expect, it } from "vitest";

import {
  compileFetchRefspecs,
  compilePushRefspecs,
  MAX_REFSPEC_EXPANDED_DESTINATIONS,
  MAX_REFSPEC_MAPPINGS,
  type PushRefspec,
  type RefspecSourceRef,
} from "../src/core/ops/refspec.js";
import { requireRefName } from "../src/sqlite/ref-validation.js";

const OID = "1".repeat(40);

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
  it("rejects an empty input list", () => {
    expectCode(() => compileFetchRefspecs([]), "EINVAL");
  });

  it("expands exact and wildcard fetch mappings in Git UTF-8 destination order", () => {
    const compiled = compileFetchRefspecs([
      { source: "refs/heads/main", destination: "refs/local/main" },
      { source: "refs/source/*", destination: "refs/destination/*", force: true },
    ]);
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
  });

  it("keeps an empty wildcard empty and combines it with nonempty mappings", () => {
    const compiled = compilePushRefspecs([
      { source: "refs/missing/*", destination: "refs/remote/missing/*" },
      { source: "refs/heads/main", destination: "refs/heads/main" },
    ]);
    expect(compiled.expand([{ name: "refs/heads/main", oid: OID }])).toEqual([
      {
        source: "refs/heads/main",
        destination: "refs/heads/main",
        oid: OID,
        force: false,
      },
    ]);
  });

  it("supports push oid sources and deletions without wildcarding them", () => {
    const oid = "a".repeat(40);
    const compiled = compilePushRefspecs([
      { source: oid, destination: "refs/checkpoints/exact", force: true },
      { source: null, destination: "refs/heads/old" },
    ]);
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
  });

  it("rejects runtime deletion force and wildcarded deletion or oid destinations", () => {
    const forcedDeletion: PushRefspec = {
      source: null,
      destination: "refs/heads/old",
    };
    Object.defineProperty(forcedDeletion, "force", { value: true });
    expectCode(() => compilePushRefspecs([forcedDeletion]), "EINVAL");
    expectCode(
      () => compilePushRefspecs([{ source: null, destination: "refs/heads/*" }]),
      "EINVAL",
    );
    expectCode(
      () => compilePushRefspecs([{ source: "a".repeat(40), destination: "refs/checkpoints/*" }]),
      "EINVAL",
    );
  });

  it("rejects malformed wildcard placement and invalid refs", () => {
    const cases: readonly (readonly [{ source: string; destination: string }, string])[] = [
      [{ source: "refs/source/*", destination: "refs/destination/exact" }, "EINVAL"],
      [{ source: "refs/source/**", destination: "refs/destination/*" }, "EINVAL"],
      [{ source: "source/main", destination: "refs/destination/main" }, "EINVALIDREF"],
      [{ source: "refs/source/main", destination: "refs/destination/.hidden" }, "EINVALIDREF"],
    ];
    for (const [refspec, code] of cases) {
      expectCode(() => compileFetchRefspecs([refspec]), code);
    }
  });

  it("accepts exact and wildcard refs at the former first byte excess", () => {
    const exactPrefix = "refs/heads/";
    const exact = `${exactPrefix}${"a".repeat(1_025 - exactPrefix.length)}`;
    const patternPrefix = "refs/source/";
    const pattern = `${patternPrefix}${"a".repeat(1_024 - patternPrefix.length)}*`;
    const compiled = compileFetchRefspecs([
      { source: exact, destination: exact },
      { source: pattern, destination: "refs/destination/*" },
    ]);
    expect(compiled.expand([{ name: exact, oid: OID }])).toEqual([
      { source: exact, destination: exact, oid: OID, force: false },
    ]);
  });

  it("rejects exact duplicates before expansion and wildcard collisions during expansion", () => {
    expectCode(
      () =>
        compileFetchRefspecs([
          { source: "refs/heads/a", destination: "refs/local/same" },
          { source: "refs/heads/b", destination: "refs/local/same" },
        ]),
      "EINVAL",
    );

    const fetch = compileFetchRefspecs([
      { source: "refs/heads/a", destination: "refs/local/a" },
      { source: "refs/source/*", destination: "refs/local/*" },
    ]);
    expectCode(
      () =>
        fetch.expand([
          { name: "refs/heads/a", oid: OID },
          { name: "refs/source/a", oid: "2".repeat(40) },
        ]),
      "EINVAL",
    );

    const push = compilePushRefspecs([
      { source: "refs/heads/a", destination: "refs/remote/a" },
      { source: "refs/source/*", destination: "refs/remote/*" },
    ]);
    expectCode(
      () =>
        push.expand([
          { name: "refs/heads/a", oid: OID },
          { name: "refs/source/a", oid: "2".repeat(40) },
        ]),
      "EINVAL",
    );
  });

  it("fails a mixed set when an exact source is missing", () => {
    const compiled = compilePushRefspecs([
      { source: "refs/source/*", destination: "refs/remote/*" },
      { source: "refs/heads/missing", destination: "refs/heads/missing" },
    ]);
    expectCode(() => compiled.expand([{ name: "refs/source/a", oid: OID }]), "EREFNOTFOUND");
  });

  it("accepts exact mapping and expansion caps and rejects their first excess", () => {
    const source: RefspecSourceRef = { name: "refs/heads/source", oid: OID };
    const exactMappings = Array.from({ length: MAX_REFSPEC_MAPPINGS }, (_, index) => ({
      source: source.name,
      destination: `refs/destination/${index.toString().padStart(4, "0")}`,
    }));
    const compiled = compileFetchRefspecs(exactMappings);
    expect(compiled.expand([source])).toHaveLength(MAX_REFSPEC_EXPANDED_DESTINATIONS);

    expectCode(
      () =>
        compileFetchRefspecs([
          ...exactMappings,
          { source: source.name, destination: "refs/destination/excess" },
        ]),
      "E2BIG",
    );

    const wildcard = compileFetchRefspecs([
      { source: "refs/source/*", destination: "refs/destination/*" },
    ]);
    const sources = Array.from({ length: MAX_REFSPEC_EXPANDED_DESTINATIONS + 1 }, (_, index) => ({
      name: `refs/source/${index}`,
      oid: OID,
    }));
    expectCode(() => wildcard.expand(sources), "E2BIG");
  });

  it("accepts an expanded destination at the former first byte excess", () => {
    const compiled = compileFetchRefspecs([
      { source: "refs/*", destination: "refs/destination/*" },
    ]);
    const sourcePrefix = "refs/";
    const destinationPrefix = "refs/destination/";
    const capture = "a".repeat(1_025 - destinationPrefix.length);
    const name = `${sourcePrefix}${capture}`;
    expect(compiled.expand([{ name, oid: OID }])).toEqual([
      {
        source: name,
        destination: `${destinationPrefix}${capture}`,
        oid: OID,
        force: false,
      },
    ]);
  });

  it("keeps stored-ref acceptance and caller-specific errors unchanged", () => {
    expect(requireRefName("main", "stored ref", "stored")).toBe("main");
    expect(requireRefName("refs/heads/main", "stored ref", "stored")).toBe("refs/heads/main");
    expectCode(() => requireRefName("refs/heads/.hidden", "stored ref", "stored"), "ECORRUPT");
    expectCode(() => requireRefName("refs/heads/.hidden", "input ref", "input"), "EINVAL");
    const formerFirstExcess = `refs/heads/${"a".repeat(1_025 - "refs/heads/".length)}`;
    expect(requireRefName(formerFirstExcess, "stored ref", "stored")).toBe(formerFirstExcess);
  });
});
