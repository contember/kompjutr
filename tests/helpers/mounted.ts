// Two agent sessions in one workspace, and session A's mounted view of it.

import { createFilesystem } from "../../packages/do/src/fs/filesystem.js";
import { createMountedFilesystem } from "../../packages/do/src/fs/mounted/view.js";
import type { Filesystem } from "../../packages/do/src/fs/types.js";
import { TestDatabase } from "./db.js";
import { SqliteTestStorage } from "./storage.js";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

function text(value: string): Uint8Array {
  return ENCODER.encode(value);
}

export interface Sessions {
  readonly base: Filesystem;
  readonly view: Filesystem;
  readonly storage: SqliteTestStorage;
}

/** Two sessions in one workspace; the view is session A's. */
export function sessions(): Sessions {
  const storage = new SqliteTestStorage();
  const base = createFilesystem(new TestDatabase(storage), { now: () => 1_700_000_000_000 });
  base.writeFiles([
    { path: "/s/a/notes.txt", bytes: text("session A notes\n") },
    { path: "/w/a/README.md", bytes: text("# A\n") },
    { path: "/w/a/src/main.ts", bytes: text("export const a = 'NEEDLE in A';\n") },
    { path: "/w/a/src/util.ts", bytes: text("export const u = 1;\n") },
    { path: "/s/b/secret.txt", bytes: text("session B NEEDLE secret\n") },
    { path: "/w/b/src/main.ts", bytes: text("export const b = 'NEEDLE in B';\n") },
    { path: "/tools/bin/tool", bytes: text("#!/bin/sh\n"), mode: 0o755 },
    { path: "/top.txt", bytes: text("outside every mount NEEDLE\n") },
    { path: "/w/a/inside", target: "src/main.ts" },
    { path: "/w/a/to-b-absolute", target: "/w/b/src/main.ts" },
    { path: "/w/a/to-b-relative", target: "../b/src/main.ts" },
    { path: "/w/a/dir-b", target: "../b/src" },
    { path: "/w/a/out-and-back", target: "../a/src/main.ts" },
    { path: "/w/a/to-session", target: "/s/a/notes.txt" },
  ]);
  const view = createMountedFilesystem(base, [
    { path: "/home/user/session", source: "/s/a", mode: "rw" },
    { path: "/home/user/workspace", source: "/w/a", mode: "rw" },
    { path: "/opt/tools", source: "/tools", mode: "ro" },
  ]);
  return { base, view, storage };
}

/** Everything session B and the outside file hold, as the base sees it. */
export function outsideState(base: Filesystem): string[] {
  const rows: string[] = [];
  for (const root of ["/s/b", "/w/b"]) {
    for (const entry of base.scanStream(base.realpath(root))) {
      rows.push(`${entry.path} ${entry.type} ${entry.size} ${entry.mtime} ${entry.mode}`);
    }
  }
  rows.push(DECODER.decode(base.readFile("/top.txt")));
  return rows;
}
