import type { RefRow, RepoStore } from "../../src/sqlite/store.js";
import { type GitFixture, slices } from "./git.js";

/** Load a fixture repository's pack and refs into a store, with no checkout. */
export async function importFixture(fixture: GitFixture, store: RepoStore): Promise<void> {
  await store.packs.ingest(slices(fixture.packAll(), 64 * 1024));
  const refs = fixture.git("show-ref");
  const puts: RefRow[] = [];
  if (refs !== "") {
    for (const line of refs.split("\n")) {
      const [oid, name] = line.split(" ");
      if (oid !== undefined && name !== undefined) puts.push({ name, target: oid });
    }
  }
  store.db.transactionSync(() => {
    store.mutateRefs(
      {
        puts,
        head: `ref: ${fixture.git("symbolic-ref", "HEAD")}`,
      },
      { actor: null, timestamp: 0, timezoneOffset: 0, reason: "update-ref" },
    );
    store.db.run("DELETE FROM git_reflog_entries WHERE repo_id = ?", store.repoId);
    store.db.run("UPDATE git_reflog_state SET next_ordinal = 0 WHERE repo_id = ?", store.repoId);
  });
}
