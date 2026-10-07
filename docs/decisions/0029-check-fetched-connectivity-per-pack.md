---
id: 0029
title: Check fetched connectivity per received pack
status: accepted
date: 2026-10-07
---

# 0029 — Check fetched connectivity per received pack

## Context

Before a fetch publishes refs, the runtime proves that everything the new refs
reach is present. Until this decision it did that with one recursive SQL
statement over the stored projections: commits from `git_commits`, trees and
blob edges from `git_tree_entries`, resolved against loose objects, complete
packs and promises. The walk starts at the fetched roots and stops only at
shallow boundaries, so every fetch re-walks the whole reachable history, not
only what the pack added.

On the full-history `blob:none` clone of Next.js v15.5.2 that statement costs
50.2 s of isolate time and reads 25.1 M native rows, a quarter of the 197 s
clone. Promise registration, which derives promised blobs from the same tree
projections, costs another 15.3 s. Both need every received tree's projection,
which blocks projecting trees on demand
([ADR-0030](0030-project-trees-on-demand.md)). The walk also caps commit roots
at 50,000 commits.

Native Git does not walk history to accept a pack. `index-pack` reads every
received object once. A clone accepts a pack whose references all resolve
inside it (`--check-self-contained-and-connected`). Otherwise the fetch runs
`rev-list --objects <new tips> --not --all`: it walks new objects and stops only
at objects **reachable from existing refs**.

Presence alone does not prove connectivity here. A pack publishes before its
fetch publishes refs. If that fetch then fails, the pack stays, and it may have
relied on a shallow boundary that was never recorded. Maintenance also sweeps
unreachable objects by OID, not in topological order, so an unreachable commit
can outlive its tree.

## Decision

We check connectivity per received pack, at ingest. The pack publishes only if
the check passes. The check is an ingest option that the network fetch
supplies. The `packs.ingest` store primitive itself stays unchecked.

While ingest resolves objects, it records each object's OID and type and every
reference its objects make:

- a commit's tree and parents;
- a tag's target, with the tag's declared type;
- a tree entry by mode: a subtree → tree, a `160000` gitlink → not checked,
  otherwise → blob.

Inside the pack's publication transaction, every reference must resolve.

- **Shallow.** A commit in the boundary has unchecked parents. The boundary is
  the current `git_shallow`, plus the response's `shallow`, minus its
  `unshallow`. `authenticateShallowTransition` keeps guarding commits that were
  present before the fetch and are now unshallowed.
- **In the pack, or in a pack this fetch operation already accepted.** The type
  must match.
- **A fresh store.** A store with no loose objects, no complete packs and no
  promises when the fetch began accepts nothing else. A clone's provisional
  repository is always fresh.
- **A non-fresh store** follows Git's `--not --all` rule:
  - An external **commit** must be reachable from the refs or `HEAD` as they
    stood when the fetch began. So must an external **tag**, which a tag
    naming another tag references.
  - An external **blob** must be present or promised.
  - An external **tree** that lies in the root-tree closure of an external
    commit proven reachable needs no further check. Such a commit is normally
    the parent that the server negotiated against. Any other external tree must
    be present, and so must its closure: every subtree present, every blob
    present or promised. Trees named directly by tags or by tree roots are the
    usual case.
- **Filtered fetches.** In a filtered fetch, a blob reference that nothing else
  resolves becomes a new promise. The unresolved blob set is exactly the
  fetch's promise set, so promise registration inserts it and no longer reads
  tree projections
  ([ADR-0015](0015-model-partial-clone-blobs-as-durable-promises.md)).

This rests on one induction: an object reachable from a ref is closed. Refs
publish only after this check. Maintenance keeps everything that is reachable.
Local ref writes such as `updateRef` are trusted, as `git update-ref` is.

Failure semantics: the store reports a missing object as `ObjectNotFoundError`,
and the fetch maps it to `EFETCHFAIL`. A type mismatch is `ECORRUPT`. A rejected
pack is never published, and its pending rows are reclaimed like those of any
interrupted ingest.

Before refs publish, each fetched root must be in a pack this fetch accepted, or
already reachable from the refs. Want selection skips a root only when it is
already reachable from the refs, not merely when it is present. A root left by
an earlier failed fetch is fetched again instead of being trusted. The root
type and tag-peel checks stay.

## Consequences

- A fresh clone checks connectivity in one pass over its pack, plus the promise
  insert.
- An incremental fetch costs:
  - work proportional to its pack;
  - a walk of the negotiated parents' root trees;
  - a commits-only reachability walk that exits early and has no cap. Proving a
    commit unreachable can take a full pass over `git_commits`. The walk keeps
    the commits it reached for the rest of the fetch, so its memory grows with
    the history walked: about 3 MB for the 30,347 commits of Next.js, and
    above 100 MB for a history of 1.3 million commits. A walk resumed for a
    later query starts from the frontier of the stopped one; SQLite does not
    know the commits already reached, so it may traverse them again, at most
    one extra pass per page of seeds. The cache only skips reporting them.
- None of that involves projections or the history of trees. The 50,000-commit
  root limit no longer applies to fetch.
- Ingest holds an in-memory table of the pack's OIDs, types and expected
  reference types. This includes distinct referenced blob OIDs that are not in
  the pack. It costs about 21 bytes per slot at bounded load. The peak is
  measured against
  [ADR-0026](0026-gate-the-workerd-clone-on-a-v8-regression-limit.md) in the
  same change.
- **Divergence from Git.** A pack that contains an object with an unresolved
  reference is rejected, even when no fetched ref reaches that object. Git
  accepts such a dangling object.
- **Changed error.** A fetched tree that names a missing subtree fails with
  `EFETCHFAIL`, as native Git's "did not send all necessary objects". It used
  to fail as `ECORRUPT` ("no complete parsed source"). The check reads an
  external tree's closure through the tree walk: a subtree with no projection
  row is an absent object and fails with `EFETCHFAIL`, while an unprojectable
  subtree (an incomplete projection) still fails with `ECORRUPT`. A tree that
  does not parse still fails ingest.
- A root that is present but not reachable from the refs costs a refetch.
- Hydration packs carry only blobs and make no references.

## Alternatives considered

- **Keep the SQL walk and tune it.** It is already a single, deduplicated,
  failures-only statement. Its cost is the size of history, and it needs every
  historical tree projection, which ADR-0030 removes.
- **Resolve external references by presence alone.** This is cheaper. A
  surviving pack from a failed shallow fetch, or a partly swept unreachable
  graph, would then satisfy it, and a ref could be published onto missing
  history.
- **Persist the shallow grafts each pack relied on.** That would make presence
  sound for the shallow case only, and it would either change Git-visible
  shallow state or add a second boundary table that every reader must
  reconcile.
- **Check the pack after publication.** A failed check would leave a published,
  unconnected pack in the store.
