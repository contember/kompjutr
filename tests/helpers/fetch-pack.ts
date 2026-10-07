// Hand-built packs served over a protocol v0 stub, for the fetch connectivity
// cases real Git refuses to produce.

import { concat, utf8 } from "../../packages/git/src/common/bytes.js";
import {
  hashObject,
  type ObjectType,
  serializeCommit,
  serializeTag,
} from "../../packages/git/src/common/objects.js";
import type { GitHttpRequest } from "../../packages/git/src/protocol/transport.js";
import { PackWriter } from "../../packages/git/src/store/pack/writer.js";
import { startStubServer } from "./http-backend.js";

export interface PackObject {
  type: ObjectType;
  data: Uint8Array;
}

export function packOf(objects: readonly PackObject[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const writer = new PackWriter((chunk) => chunks.push(chunk));
  writer.header(objects.length);
  for (const object of objects) writer.object(object.type, object.data);
  writer.finish();
  return concat(chunks);
}

/** One object of the pack together with its OID. */
export function packed(type: ObjectType, data: Uint8Array): PackObject & { oid: string } {
  return { type, data, oid: hashObject(type, data) };
}

const PERSON = {
  name: "Pack",
  email: "pack@example.com",
  timestamp: 1_700_000_000,
  timezoneOffset: 0,
};

export function commitObject(tree: string, parents: readonly string[] = [], message = "commit\n") {
  return packed(
    "commit",
    serializeCommit({ tree, parent: [...parents], author: PERSON, committer: PERSON, message }),
  );
}

export function tagObject(object: string, type: ObjectType, name: string) {
  return packed(
    "tag",
    serializeTag({ object, type, tag: name, tagger: PERSON, message: `${name}\n` }),
  );
}

function packet(payload: Uint8Array | string): Uint8Array {
  const bytes = typeof payload === "string" ? utf8.encode(payload) : payload;
  return concat([utf8.encode((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
}

/**
 * A remote advertising `refs/heads/main` at `tip` that answers every
 * upload-pack request with `pack`, optionally announcing `shallow` first.
 */
export async function packRemote(
  pack: Uint8Array,
  tip: string,
  options: { shallow?: readonly string[]; filter?: boolean } = {},
) {
  const capabilities = [
    "side-band-64k",
    "shallow",
    "symref=HEAD:refs/heads/main",
    ...(options.filter === true ? ["filter"] : []),
  ].join(" ");
  const advertisement = concat([
    packet("# service=git-upload-pack\n"),
    utf8.encode("0000"),
    packet(`${tip} HEAD\0${capabilities}\n`),
    packet(`${tip} refs/heads/main\n`),
    utf8.encode("0000"),
  ]);
  const shallow = (options.shallow ?? []).map((oid) => packet(`shallow ${oid}\n`));
  const parts = shallow.length === 0 ? [] : [...shallow, utf8.encode("0000")];
  parts.push(packet("NAK\n"));
  for (let offset = 0; offset < pack.length; offset += 65_515) {
    parts.push(packet(concat([new Uint8Array([1]), pack.subarray(offset, offset + 65_515)])));
  }
  parts.push(utf8.encode("0000"));
  const response = concat(parts);
  return startStubServer((request, reply) => {
    reply.setHeader(
      "Content-Type",
      request.method === "POST"
        ? "application/x-git-upload-pack-result"
        : "application/x-git-upload-pack-advertisement",
    );
    if (request.method !== "POST") {
      reply.end(advertisement);
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      // A stateless deepen request first asks for the shallow section alone.
      if (shallow.length > 0 && !body.includes("done\n")) {
        reply.end(concat([...shallow, utf8.encode("0000")]));
      } else reply.end(response);
    });
  });
}

/** Drop `include-tag`, so a server sends annotated tags only when asked for them. */
export function withoutIncludeTag(request: GitHttpRequest): GitHttpRequest {
  if (request.method !== "POST" || !(request.body instanceof Uint8Array)) return request;
  const decoder = new TextDecoder();
  const frameLength = Number.parseInt(decoder.decode(request.body.subarray(0, 4)), 16);
  if (!Number.isSafeInteger(frameLength) || frameLength < 4 || frameLength > request.body.length) {
    throw new Error("invalid upload-pack request frame");
  }
  const line = decoder.decode(request.body.subarray(4, frameLength));
  const rewritten = line.replace(" include-tag", "");
  if (rewritten === line) return request;
  return {
    ...request,
    body: concat([packet(rewritten), request.body.subarray(frameLength)]),
  };
}
