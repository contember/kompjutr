import { spawn } from "node:child_process";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { startStubServer } from "./http-backend.js";

export async function runGit(cwd: string, args: readonly string[], input?: Uint8Array) {
  const child = spawn("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00+0000",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00+0000",
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      LC_ALL: "C",
    },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(input);
  const [code] = await once(child, "close");
  const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result;
}

/** Bridge the production Fetch handler to a native Git client without buffering a pack. */
export async function startHandlerServer(handler: (request: Request) => Promise<Response>) {
  const errors: unknown[] = [];
  const server = await startStubServer((request, response) => {
    serve(request, response, handler).catch((error) => {
      errors.push(error);
      response.destroy();
    });
  });
  return { ...server, errors };
}

async function serve(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  handler: (request: Request) => Promise<Response>,
): Promise<void> {
  const controller = new AbortController();
  outgoing.on("close", () => {
    if (!outgoing.writableFinished) controller.abort();
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (value !== undefined) for (const item of value) headers.append(name, item);
  }
  const method = incoming.method ?? "GET";
  const iterator = incoming[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      const next = await iterator.next();
      if (next.done) stream.close();
      else if (next.value instanceof Uint8Array) stream.enqueue(next.value);
      else stream.error(new Error("HTTP body chunk is not bytes"));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    method,
    headers,
    signal: controller.signal,
    duplex: "half",
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
  };
  const request = new Request(`http://${incoming.headers.host}${incoming.url}`, init);
  const response = await handler(request);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  const reader = response.body?.getReader();
  if (reader !== undefined) {
    const cancel = () => void reader.cancel(controller.signal.reason);
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (!outgoing.write(next.value))
          await once(outgoing, "drain", { signal: controller.signal });
      }
    } finally {
      controller.signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  }
  outgoing.end();
}
