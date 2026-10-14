import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { concat, utf8 } from "../../packages/git/src/common/bytes.js";
import { hashObject, type ObjectType } from "../../packages/git/src/common/objects.js";
import { SqliteGitDatabase } from "../../packages/git/src/store/index.js";
import { PackWriter } from "../../packages/git/src/store/pack/writer.js";
import { validateCompleteClosure } from "../../packages/git/src/store/transfer/closure.js";
import { TestDatabase } from "../helpers/db.js";
import { GitFixture, slices } from "../helpers/git.js";

const fixtures: GitFixture[] = [];
afterEach(() => {
  for (const git of fixtures.splice(0)) git.dispose();
});
const missing = "1234567890123456789012345678901234567890";
const person = "Fixture <fixture@example.com> 1577836800 +0000";

interface MalformedCase {
  type: ObjectType;
  header: string;
  body(tree: string, blob: string): string;
}
const cases: MalformedCase[] = [
  {
    type: "commit",
    header: "tree",
    body: (tree) =>
      `tree ${missing}\ntree ${tree}\nauthor ${person}\ncommitter ${person}\n\nduplicate tree\n`,
  },
  {
    type: "tag",
    header: "object",
    body: (_, blob) =>
      `object ${missing}\nobject ${blob}\ntype blob\ntag invalid\ntagger ${person}\n\nduplicate object\n`,
  },
  {
    type: "tag",
    header: "type",
    body: (_, blob) =>
      `object ${blob}\ntype tree\ntype blob\ntag invalid\ntagger ${person}\n\nduplicate type\n`,
  },
];

describe("strict incoming closure validation", () => {
  it.each(cases)(
    "rejects duplicate $type $header headers before pack publication",
    async ({ type, header, body }) => {
      const db = new TestDatabase();
      const store = new SqliteGitDatabase(db).createBareRepository();
      const tree = store.write("tree", new Uint8Array());
      const blob = store.write("blob", utf8.encode("body"));
      store.setRef("refs/tags/existing", blob);
      const bytes = utf8.encode(body(tree, blob));
      const oid = hashObject(type, bytes);
      const chunks: Uint8Array[] = [];
      const writer = new PackWriter((chunk) => chunks.push(chunk));
      writer.header(1);
      writer.object(type, bytes);
      writer.finish();
      await expect(
        store.packs.ingest(slices(concat(chunks), 17), {
          lifecycle: {
            reserved() {},
            published() {
              db.run(
                "UPDATE git_refs SET target = ? WHERE repo_id = ? AND name = 'refs/tags/existing'",
                oid,
                store.repoId,
              );
              validateCompleteClosure(store, [{ oid, type }]);
            },
          },
        }),
      ).rejects.toThrow(`duplicate ${header}`);
      expect(store.read(oid)).toBeNull();
      expect(store.getRef("refs/tags/existing")).toBe(blob);
      expect(db.scalar<number>("SELECT count(*) FROM git_pack_meta WHERE state = 'complete'")).toBe(
        0,
      );
      expect(db.scalar<number>("SELECT count(*) FROM git_transfers")).toBe(0);

      const git = new GitFixture();
      fixtures.push(git);
      git.git("init", "-q", "-b", "main");
      expect(git.writeObject("tree", new Uint8Array())).toBe(tree);
      expect(git.writeObject("blob", utf8.encode("body"))).toBe(blob);
      execFileSync("git", ["hash-object", "--literally", "-w", "-t", type, "--stdin"], {
        cwd: git.dir,
        input: bytes,
      });
      expect(git.gitResult("fsck", "--full").status).not.toBe(0);
      if (type === "commit") expect(git.gitResult("rev-list", "--objects", oid).status).not.toBe(0);
    },
  );
});
