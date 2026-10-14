import { gunzipSync } from "node:zlib";
import { pkt } from "../../packages/git/src/protocol/pktline.js";
import { createGitServer } from "../../packages/git/src/server.js";
import type { SharedRepoStore } from "../../packages/git/src/store/index.js";
import { frames, type OracleExchange } from "./server-oracle.js";
import { startHandlerServer } from "./server-oracle-http.js";

/** Small native-client fixtures capture bytes; only optional discovery capabilities are removed. */
export async function startUploadServer(store: SharedRepoStore, fallback = false) {
  const server = createGitServer(store, { maxPackBytes: 16 * 1024 * 1024 });
  const exchanges: OracleExchange[] = [];
  const transport = await startHandlerServer(async (request) => {
    const url = new URL(request.url);
    const body = Buffer.from(await request.arrayBuffer());
    url.pathname = url.pathname.slice("/repo".length);
    const response = await server.fetch(
      new Request(url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        ...(request.method === "POST" ? { body } : {}),
      }),
    );
    let bytes = Buffer.from(await response.arrayBuffer());

    if (fallback && request.method === "GET" && response.ok) {
      bytes = Buffer.concat(
        frames(bytes).packets.map((packet) => {
          if (packet.length === 0) return Buffer.from("0000");
          const nul = packet.indexOf(0);
          if (nul < 0) return Buffer.from(pkt(packet));
          const capabilities = packet
            .subarray(nul + 1)
            .toString()
            .trim()
            .split(" ")
            .filter((value) => value !== "multi_ack_detailed" && value !== "side-band-64k");
          return Buffer.from(
            pkt(`${packet.subarray(0, nul).toString()}\0${capabilities.join(" ")}\n`),
          );
        }),
      );
    }
    exchanges.push({
      method: request.method,
      path: url.pathname,
      protocol: request.headers.get("git-protocol"),
      request: request.headers.get("content-encoding") === "gzip" ? gunzipSync(body) : body,
      response: bytes,
    });
    return new Response(bytes, { status: response.status, headers: response.headers });
  });
  return { ...transport, exchanges };
}
