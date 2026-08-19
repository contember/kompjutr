import type { RepoStore } from "../../src/sqlite/store.js";
import { type GitFixture, slices } from "./git.js";

/** Load a fixture repository's pack and refs into a store, with no checkout. */
export async function importFixture(fixture: GitFixture, store: RepoStore): Promise<void> {
  await store.packs.ingest(slices(fixture.packAll(), 64 * 1024));
  const refs = fixture.git("show-ref");
  if (refs !== "") {
    for (const line of refs.split("\n")) {
      const [oid, name] = line.split(" ");
      if (oid !== undefined && name !== undefined) store.setRef(name, oid);
    }
  }
  store.setHead(`ref: ${fixture.git("symbolic-ref", "HEAD")}`);
}
