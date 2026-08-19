// Minimal stand-in for the `cloudflare:workers` module so
// @cloudflare/computer can be imported under plain node/vitest.
// Only the two classes it pulls in at module scope are needed; the
// Workspace paths these tests exercise never construct either.

export class RpcTarget {}

export class WorkerEntrypoint {
  constructor(
    readonly ctx: unknown,
    readonly env: unknown,
  ) {}
}

export class DurableObject {
  constructor(
    readonly ctx: unknown,
    readonly env: unknown,
  ) {}
}
