import { pkt } from "../../packages/git/src/protocol/pktline.js";
import { startGitServer } from "./http-backend.js";
import { startHandlerServer } from "./server-oracle-http.js";

export const RECEIVE_CAPABILITIES = ["report-status", "delete-refs", "no-thin"];
export const UPLOAD_CAPABILITIES = [
  "multi_ack_detailed",
  "side-band-64k",
  "symref=HEAD:refs/heads/main",
];

export interface OracleExchange {
  method: string;
  path: string;
  protocol: string | null;
  request: Buffer;
  response: Buffer;
}

export function frames(bytes: Buffer): { packets: Buffer[]; rest: Buffer } {
  const packets: Buffer[] = [];
  let offset = 0;
  while (offset < bytes.length && bytes.subarray(offset, offset + 4).toString() !== "PACK") {
    const prefix = bytes.subarray(offset, offset + 4).toString();
    if (!/^[0-9a-f]{4}$/.test(prefix)) throw new Error(`invalid packet prefix ${prefix}`);
    const size = Number.parseInt(prefix, 16);
    if (size === 0) {
      packets.push(Buffer.alloc(0));
      offset += 4;
      continue;
    }
    if (size < 4 || offset + size > bytes.length) throw new Error("truncated pkt-line");
    packets.push(bytes.subarray(offset + 4, offset + size));
    offset += size;
  }
  return { packets, rest: bytes.subarray(offset) };
}

export function packetText(bytes: Buffer): string[] {
  return frames(bytes).packets.map((packet) => packet.toString());
}

/** Only discovery capabilities change; every command, ACK and pack comes from native Git. */
export async function startProtocolOracle(root: string, detailed = true, sideband = true) {
  const native = await startGitServer(root);
  const exchanges: OracleExchange[] = [];
  const proxy = await startHandlerServer(async (request) => {
    const url = new URL(request.url);
    const body = Buffer.from(await request.arrayBuffer());
    const target = `${native.url}${url.pathname.slice("/repo".length)}${url.search}`;
    const upstream = await fetch(target, {
      method: request.method,
      headers: request.headers,
      ...(request.method === "GET" ? {} : { body }),
    });
    let bytes = Buffer.from(await upstream.arrayBuffer());
    if (request.method === "GET" && url.pathname.endsWith("/info/refs")) {
      const capabilities =
        url.searchParams.get("service") === "git-receive-pack"
          ? RECEIVE_CAPABILITIES
          : UPLOAD_CAPABILITIES.filter(
              (capability) =>
                (detailed || capability !== "multi_ack_detailed") &&
                (sideband || capability !== "side-band-64k"),
            );
      bytes = replaceCapabilities(bytes, capabilities);
    }
    exchanges.push({
      method: request.method,
      path: url.pathname,
      protocol: request.headers.get("git-protocol"),
      request: body,
      response: bytes,
    });
    const headers = new Headers(upstream.headers);
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    return new Response(bytes, { status: upstream.status, headers });
  });
  return {
    url: proxy.url,
    exchanges,
    errors: proxy.errors,
    async close() {
      await proxy.close();
      await native.close();
    },
  };
}

function replaceCapabilities(bytes: Buffer, capabilities: readonly string[]): Buffer<ArrayBuffer> {
  const { packets, rest } = frames(bytes);
  if (rest.length !== 0) throw new Error("pack in discovery");
  return Buffer.concat(
    packets.map((packet) => {
      if (packet.length === 0) return Buffer.from("0000");
      const nul = packet.indexOf(0);
      if (nul < 0) return Buffer.from(pkt(packet));
      return Buffer.from(pkt(`${packet.subarray(0, nul).toString()}\0${capabilities.join(" ")}\n`));
    }),
  );
}
