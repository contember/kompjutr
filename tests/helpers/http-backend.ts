// A real Smart HTTP server for protocol tests: `git http-backend` driven
// as a CGI program by node:http. Correctness of the wire protocol is
// checked against git's own server, not against a mock of our own.

import { execFileSync, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { basename, dirname, join } from "node:path";

const CGI_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_HTTP_EXPORT_ALL: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  LC_ALL: "C",
};

function backendPath(): string {
  const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  return join(execPath, "git-http-backend");
}

export interface RequestRecord {
  method: string;
  path: string;
  query: string;
}

export interface GitServerOptions {
  /** Answer 401 until the client sends an Authorization header. */
  requireAuth?: boolean;
  /** Destroy the connection after this many bytes of a POST response body. */
  truncatePostAfter?: number;
}

export interface GitServer {
  /** The remote URL of the served repository. */
  url: string;
  /** Every request the server saw, in order. */
  requests: RequestRecord[];
  close(): Promise<void>;
}

/**
 * Serve one repository over Smart HTTP. `root` is its working directory;
 * the parent becomes GIT_PROJECT_ROOT so PATH_INFO can name it.
 */
export async function startGitServer(
  root: string,
  options: GitServerOptions = {},
): Promise<GitServer> {
  const backend = backendPath();
  const projectRoot = dirname(root);
  const name = basename(root);
  const requests: RequestRecord[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((request, response) => {
    handle(request, response, backend, projectRoot, requests, options).catch(() => {
      // A client that walked away mid-response is a case under test.
      response.destroy();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = addressPort(server);

  return {
    url: `http://127.0.0.1:${port}/${name}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A bare node:http server, for the non-smart and hostile-response cases. */
export async function startStubServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = addressPort(server);
  return {
    url: `http://127.0.0.1:${port}/repo`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function addressPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no TCP port");
  return address.port;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  backend: string,
  projectRoot: string,
  requests: RequestRecord[],
  options: GitServerOptions,
): Promise<void> {
  const target = request.url ?? "/";
  const separator = target.indexOf("?");
  const pathInfo = separator < 0 ? target : target.slice(0, separator);
  const query = separator < 0 ? "" : target.slice(separator + 1);
  const method = request.method ?? "GET";
  requests.push({ method, path: pathInfo, query });

  if (options.requireAuth === true && request.headers.authorization === undefined) {
    await drain(request);
    response.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="git"',
      "Content-Type": "text/plain",
    });
    response.end("authentication required\n");
    return;
  }

  const body = await readBody(request);
  const child = spawn(backend, [], {
    env: {
      ...CGI_ENV,
      GIT_PROJECT_ROOT: projectRoot,
      REQUEST_METHOD: method,
      PATH_INFO: pathInfo,
      QUERY_STRING: query,
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      CONTENT_LENGTH: String(body.length),
      REMOTE_ADDR: "127.0.0.1",
      REMOTE_USER: "tester",
    },
  });
  child.stderr.resume();
  child.stdin.end(body);

  const limit = method === "POST" ? options.truncatePostAfter : undefined;
  await pipeCgi(child.stdout, response, limit, () => child.kill("SIGKILL"));
}

async function drain(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) {
    // discard
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Translate the CGI response into an HTTP one. Headers are buffered until
 * the blank line; the body is forwarded chunk by chunk, so a pack is never
 * assembled on the server side either.
 */
async function pipeCgi(
  stdout: AsyncIterable<Buffer>,
  response: ServerResponse,
  truncateAfter: number | undefined,
  abort: () => void,
): Promise<void> {
  let head: Buffer = Buffer.alloc(0);
  let headersSent = false;
  let written = 0;

  const send = (chunk: Buffer): boolean => {
    if (truncateAfter === undefined) {
      response.write(chunk);
      return true;
    }
    const room = truncateAfter - written;
    if (chunk.length < room) {
      written += chunk.length;
      response.write(chunk);
      return true;
    }
    response.write(chunk.subarray(0, Math.max(room, 0)));
    abort();
    response.destroy();
    return false;
  };

  for await (const chunk of stdout) {
    if (!headersSent) {
      head = Buffer.concat([head, chunk]);
      const split = headerEnd(head);
      if (split === null) continue;
      const { status, headers } = parseCgiHeaders(head.subarray(0, split.at).toString("latin1"));
      response.writeHead(status, headers);
      headersSent = true;
      const rest = head.subarray(split.at + split.length);
      head = Buffer.alloc(0);
      if (rest.length > 0 && !send(rest)) return;
      continue;
    }
    if (!send(chunk)) return;
  }

  if (!headersSent) {
    const { status, headers } = parseCgiHeaders(head.toString("latin1"));
    response.writeHead(status, headers);
  }
  response.end();
}

function headerEnd(buffer: Buffer): { at: number; length: number } | null {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) return { at: crlf, length: 4 };
  const lf = buffer.indexOf("\n\n");
  if (lf >= 0) return { at: lf, length: 2 };
  return null;
}

function parseCgiHeaders(text: string): { status: number; headers: Record<string, string> } {
  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") {
      const code = Number.parseInt(value.slice(0, 3), 10);
      if (Number.isFinite(code)) status = code;
      continue;
    }
    headers[name] = value;
  }
  return { status, headers };
}
