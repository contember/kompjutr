# Bare Git Smart HTTP server

`createGitServer()` serves a SQLite bare repository to ordinary Git clients.
It exposes discovery, clone/fetch (`upload-pack`), and push (`receive-pack`).
Push changes shared refs and objects. It never updates checkout files or indexes.

## Repository and HTTP ownership

```ts
import { createGitServer, Database, SqliteGitDatabase } from "@kompjutr/do";

const database = new SqliteGitDatabase(new Database(ctx.storage));
const repository = database.createBareRepository("refs/heads/main");
const server = createGitServer(repository, { maxPackBytes: 256 * 1024 * 1024 });
```

Create once and persist `repository.repoId` in application-owned state. On a cold
start, use `database.openBareRepository(repoId)`. Opening a workspace repository
as bare fails. The default branch belongs to the repository and is independent
of checkout `HEAD`; use `defaultBranch()` and `setDefaultBranch()` to inspect or
change it. A bare repository has no primary checkout. Explicit ordinary
checkouts can be added and removed independently.

The caller authenticates and authorizes **every** request, including direct
POSTs, before selecting the repository. The server binds one store and accepts
only these paths after the application strips its repository mount:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/info/refs?service=git-upload-pack` | Read discovery |
| GET | `/info/refs?service=git-receive-pack` | Write discovery |
| POST | `/git-upload-pack` | Fetch negotiation and pack response |
| POST | `/git-receive-pack` | Pack ingestion and ref publication |

`receivePack: false` disables both write routes before consuming a request body.
`maxPackBytes` is required and bounds actual incoming pack bytes, independent of
the supplied Content-Length. HTTP gzip request decoding is supported. The
[Durable Object example](../../examples/git-server/README.md) includes repository
routing, Basic authentication, persisted identity and alarm maintenance. Its
tokens cover all repository names; applications own any finer access policy.

## Protocol contract

The server speaks SHA-1 Smart HTTP v0. Modern Git's protocol-v2 request falls
back to v0. Discovery exposes `refs/heads/*`, `refs/tags/*`, peeled annotated
tags, and the repository default `HEAD` symref. An empty v0 repository cannot
reliably communicate its unborn default branch to every native client; an
empty clone can retain the client's configured initial branch.

| Service | Advertised capabilities |
| --- | --- |
| upload-pack | `multi_ack_detailed`, `side-band-64k`, default `HEAD` symref |
| receive-pack | `report-status`, `delete-refs`, `no-thin` |

Fetch negotiation is stateless across POSTs. A want must name a currently
exposed tip or peeled target. A have becomes common only after reachability
proof in the served repository. Mere object presence grants no access.
Without detailed ACK negotiation, nonterminal requests receive NAK; the
terminal request proves its own common closure or receives the full closure.

Outgoing packs contain full objects and no deltas. Incoming packs must be
self-contained. Shallow boundaries and unresolved promised objects prevent
serving. Protocol v2, SHA-256, shallow/deepen, filters, LFS, SSH, hooks,
push options and negotiated atomic pushes are unsupported.

Discovery and negotiation allow at most 16,384 entries, receive allows 1,024
commands, and ref names allow 1,024 UTF-8 bytes. These bound retained request
metadata. Duplicate receive destinations fail. Repeated wants/haves are
deduplicated but still count toward the incoming frame bound. The existing
48 MiB individual object limit also applies. Oversized requests fail explicitly.

## Push publication

Ingest authenticates the pack and validates complete connectivity and object
types for every incoming object and every nonzero command target. Branch tips
must be commits. A malformed graph rolls back the whole incoming publication.
Old-OID checks, namespace conflicts and attached-checkout protection run in the
final synchronous transaction. A checkout attached while a pack is uploading
still protects its branch.

Ordinary multi-ref pushes return per-ref outcomes. The accepted subset and pack
publish in one transaction; an all-rejected request publishes no incoming pack.
Cleanup belongs to the exact provisional owner. Once committed, cancellation
or a lost response cannot undo the refs or delete the published pack. Clients
must inspect remote state after an uncertain response.

Symbolic heads and tags resolve to their effective destination for old-OID
checks, updates and deletion; their symbolic rows remain unchanged. The entire
checkout `HEAD` chain is protected. Aliases cannot escape the served namespaces.
A direct destination command and its aliases coalesce only when all old/new
OIDs agree; inconsistent groups fail together. With several aliases and no
direct destination command, the first command may proceed and later aliases
receive `refname conflict`. This deterministic rule deliberately differs from
Git 2.54 Smart HTTP batching, whose duplicate-alias outcomes vary with alias
depth and deletion. Ordinary alias behavior has native differential tests;
separate characterization tests record this compatibility boundary.

## Streaming and maintenance

SQL rows hold each upload's frontier, visited set and planned object IDs.
Bounded pages compute wanted closure minus proven common closure. Pack output
obeys backpressure and yields cooperatively. No SQL cursor or transaction spans
an await, and object sources are reacquired after storage changes.

Each transfer retains its roots until explicit release. Its renewable five-
minute expiry prevents an abandoned reader from resuming. Expiry alone does
not remove GC roots: bounded maintenance releases the owner and advances the
root epoch before deleting scratch pages. Success and cancellation release
ownership immediately, including cancellation before the first output read.
See [ADR-0033](../decisions/0033-retain-transfer-roots-until-explicit-release.md).

Call `maintainRepository(database, repoId, { nowMs })` repeatedly to advance
bounded cleanup without a checkout. Schedule `nextEligibleAt` after a complete
result. The example persists alarms before serving and preserves earlier
deadlines under continuous traffic. Runtime yielding does not reset the
platform's request CPU allowance.

Native compatibility and interleaving witnesses live in `tests/server/`.
The [benchmark harness](../../bench/server/README.md) records synthetic Node and
actual-workerd serving cost. Local workerd RSS is process memory, and sampled
V8 memory is a lower bound; neither proves production isolate fit.
