import { isOid } from "../common/bytes.js";
import { CorruptError, GitError } from "../common/errors.js";
import { checkRefText, hasCanonicalRefSyntax } from "../common/ref-name.js";
import {
  baseHeaders,
  drain,
  NegotiationBudget,
  normalizeRemoteUrl,
  ownedPktText,
  type ProtocolRequestOptions,
  readErrorPrefix,
  releaseReader,
  resolvedProtocolEntryLimit,
  type Service,
} from "./remote-base.js";
import { ByteReader, type Pkt } from "./stream.js";
import { HttpError, requestWithAuth } from "./transport.js";

const ZERO = "0".repeat(40);
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

type DiscoveryRequestOptions = ProtocolRequestOptions;

export interface RemoteRef {
  name: string;
  oid: string;
}

export interface Advertisement {
  refs: RemoteRef[];
  capabilities: Set<string>;
  /** The branch HEAD points at, when the server advertises a symref. */
  headRef: string | null;
}

export async function discover(
  url: string,
  service: Service,
  options: DiscoveryRequestOptions = {},
): Promise<Advertisement> {
  const budget = new NegotiationBudget(resolvedProtocolEntryLimit(options.protocolLimits?.entries));
  const base = normalizeRemoteUrl(url);
  const response = await requestWithAuth(
    {
      url: `${base}/info/refs?service=${service}`,
      method: "GET",
      headers: baseHeaders(),
    },
    options,
    options.authSession,
  );
  if (response.status !== 200) {
    const body = await readErrorPrefix(response.body, options.signal);
    throw new HttpError(
      response.status,
      `${service} discovery failed: ${response.status} ${response.statusText}${body === "" ? "" : ` — ${body.slice(0, 200)}`}`,
    );
  }

  // A dumb-HTTP or plain-web server answers 200 with something that is not
  // pkt-lines. Its content-type is the only reliable way to say so before
  // the framing desynchronises on arbitrary bytes.
  const contentType = response.headers["content-type"] ?? "";
  const mediaType = contentType.split(";")[0]?.trim() ?? "";
  if (!mediaType.startsWith(`application/x-${service}-advertisement`)) {
    await drain(response.body, options.signal);
    throw new CorruptError(
      `not a smart HTTP ref advertisement (content-type: ${contentType === "" ? "none" : contentType})`,
    );
  }

  const reader = new ByteReader(response.body, options.signal);
  try {
    const first = await reader.readPkt();
    if (first === null) throw new CorruptError("empty ref advertisement");
    const header = first.kind === "line" ? ownedPktText(first) : "";
    if (header.startsWith("ERR ")) {
      throw serviceError(service, header.slice(4));
    }
    if (!header.startsWith("# service=")) {
      throw new CorruptError("not a smart HTTP ref advertisement");
    }
    const afterHeader = await reader.readPkt();
    if (afterHeader === null || afterHeader.kind !== "flush") {
      throw new CorruptError("malformed ref advertisement header");
    }
    return await parseAdvertisement(reader, budget, service);
  } finally {
    await releaseReader(reader);
  }
}

async function parseAdvertisement(
  reader: ByteReader,
  budget: NegotiationBudget,
  service: Service,
): Promise<Advertisement> {
  const refs: RemoteRef[] = [];
  const capabilities = new Set<string>();
  const refNames = new Set<string>();
  let headRef: string | null = null;
  let headOid: string | null = null;
  let first = true;
  let flushed = false;

  for (;;) {
    const line: Pkt | null = await reader.readPkt();
    if (line === null) break;
    if (line.kind === "flush") {
      flushed = true;
      break;
    }
    if (line.kind !== "line") {
      throw new CorruptError("ref advertisement contains an unexpected pkt-line control");
    }
    let text: string;
    try {
      text = strictUtf8Decoder.decode(line.payload);
    } catch (error) {
      throw new CorruptError("ref advertisement contains malformed UTF-8", { cause: error });
    }
    if (text.endsWith("\n")) {
      text = text.slice(0, -1);
    }
    if (first) {
      first = false;
      const nul = text.indexOf("\0");
      if (nul >= 0) {
        let start = nul + 1;
        while (start < text.length) {
          while (text[start] === " ") start++;
          if (start >= text.length) break;
          let end = text.indexOf(" ", start);
          if (end < 0) end = text.length;
          budget.countEntry();
          const capability = text.slice(start, end);
          if (capability.includes("\0")) {
            throw new CorruptError("ref advertisement has malformed capabilities");
          }
          if (capability.startsWith("symref=HEAD")) {
            if (!capability.startsWith("symref=HEAD:")) {
              throw new CorruptError("ref advertisement has a malformed HEAD symref");
            }
            const symref = capability.slice("symref=HEAD:".length);
            const checked = checkRefText(symref);
            if (
              checked.problem !== null ||
              !symref.startsWith("refs/") ||
              !hasCanonicalRefSyntax(symref)
            ) {
              throw new CorruptError("ref advertisement has a malformed HEAD symref");
            }
            if (headRef !== null && headRef !== symref) {
              throw new CorruptError("ref advertisement has conflicting HEAD symrefs");
            }
            if (headRef === null) {
              headRef = symref;
            }
          }
          capabilities.add(capability);
          start = end + 1;
        }
        text = text.slice(0, nul);
      }
    }
    if (text.startsWith("ERR ")) {
      throw serviceError(service, text.slice(4));
    }
    const space = text.indexOf(" ");
    if (space < 0) throw new CorruptError("ref advertisement has a malformed row");
    const nameStart = space + 1;
    const synthetic =
      space === ZERO.length &&
      text.startsWith(ZERO) &&
      text.length - nameStart === "capabilities^{}".length &&
      text.startsWith("capabilities^{}", nameStart);
    const oid = text.slice(0, space);
    const name = text.slice(nameStart);
    if (!isOid(oid)) throw new CorruptError(`ref advertisement has an invalid oid for ${name}`);
    if (refNames.has(name)) throw new CorruptError(`ref advertisement has duplicate row ${name}`);
    refNames.add(name);
    // An empty repository advertises only the capabilities line.
    if (synthetic) {
      continue;
    }
    budget.countEntry();
    const checked = checkRefText(name);
    if (checked.problem !== null || !advertisedRefName(name)) {
      throw new CorruptError(`ref advertisement has an invalid ref name ${name}`);
    }
    refs.push({ name, oid });
    if (name === "HEAD") headOid = oid;
  }
  if (!flushed) throw new CorruptError("truncated ref advertisement");
  if (headRef !== null && headOid !== null) {
    const targetOid = refs.find((ref) => ref.name === headRef)?.oid;
    if (targetOid !== undefined && targetOid !== headOid) {
      throw new CorruptError("advertised HEAD does not match its symref target");
    }
  }
  return { refs, capabilities, headRef };
}

function serviceError(service: Service, message: string): GitError {
  return new GitError(service === "git-receive-pack" ? "EPUSHREJECTED" : "EFETCHFAIL", message);
}

function advertisedRefName(name: string): boolean {
  if (name === "HEAD") return true;
  if (name.endsWith("^{}")) {
    const baseEnd = name.length - 3;
    return name.startsWith("refs/tags/") && hasCanonicalRefSyntax(name, 0, baseEnd);
  }
  return name.startsWith("refs/") && hasCanonicalRefSyntax(name);
}
