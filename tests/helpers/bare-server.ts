import type { UnderlyingSource } from "node:stream/web";
import { concat } from "../../packages/git/src/common/bytes.js";
import {
  createGitServer,
  type GitServerOptions,
  SqliteGitDatabase,
} from "../../packages/git/src/index.js";
import { FLUSH, pkt } from "../../packages/git/src/protocol/pktline.js";
import type { ReceivePackCommand } from "../../packages/git/src/protocol/receive-pack-types.js";
import { TestDatabase } from "./db.js";
import { startHandlerServer } from "./server-oracle-http.js";

export function bareServer(options: Partial<GitServerOptions> = {}) {
  const db = new TestDatabase();
  const database = new SqliteGitDatabase(db);
  const store = database.createBareRepository();
  const server = createGitServer(store, { maxPackBytes: 16 * 1024 * 1024, ...options });
  return {
    db,
    database,
    store,
    server,
    async listen() {
      return startHandlerServer((request) => {
        const url = new URL(request.url);
        url.pathname = url.pathname.slice("/repo".length) || "/";
        return server.fetch(new Request(url, request));
      });
    },
  };
}

export function pushBytes(commands: readonly ReceivePackCommand[], pack?: Uint8Array): Uint8Array {
  return concat([
    ...commands.map((command, index) =>
      pkt(
        `${command.oldOid} ${command.newOid} ${command.ref}${index === 0 ? "\0report-status" : ""}`,
      ),
    ),
    FLUSH,
    ...(pack === undefined ? [] : [pack]),
  ]);
}

export function pushRequest(bytes: Uint8Array, signal?: AbortSignal): Request {
  return new Request("https://git.test/git-receive-pack", {
    method: "POST",
    headers: { "Content-Type": "application/x-git-receive-pack-request" },
    body: Uint8Array.from(bytes),
    ...(signal === undefined ? {} : { signal }),
  });
}

export function streamPushRequest(
  source: UnderlyingSource<Uint8Array>,
  signal?: AbortSignal,
): Request {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: { "Content-Type": "application/x-git-receive-pack-request" },
    body: new ReadableStream(source, { highWaterMark: 0 }),
    duplex: "half",
    ...(signal === undefined ? {} : { signal }),
  };
  return new Request("https://git.test/git-receive-pack", init);
}
