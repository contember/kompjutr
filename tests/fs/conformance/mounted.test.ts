// The ported conformance cases, run again through a mounted view.
//
// The view mounts `/` onto the real `/root`, so every path the cases name is
// translated both ways and every resolution is confined. A mount at `/` is
// the top of its namespace, as a chroot is, which is what lets the cases'
// absolute symlink targets and `..` above the root keep their meaning.

import { vi } from "vitest";

vi.mock("./target.js", async () => {
  const { createFilesystem } = await import("../../../packages/do/src/fs/filesystem.js");
  const { createMountedFilesystem } = await import("../../../packages/do/src/fs/mounted/view.js");
  return {
    storedPath: (path: string) => (path === "/" ? "/root" : `/root${path}`),
    createFilesystemOps(
      db: import("../../../packages/do/src/db/db.js").SqlDatabase,
      options: { now?: () => number } = {},
    ) {
      const base = createFilesystem(db, options);
      base.mkdir("/root");
      return createMountedFilesystem(base, [{ path: "/", source: "/root", mode: "rw" }]);
    },
  };
});

import "./chmod.test.js";
import "./link.test.js";
import "./mkdir.test.js";
import "./readdir.test.js";
import "./readFile.test.js";
import "./rename.test.js";
import "./rm.test.js";
import "./stat.test.js";
import "./symlink.test.js";
import "./writeFile.test.js";
