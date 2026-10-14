---
id: 0032
title: Serve bare repositories with explicit checkouts
status: accepted
date: 2026-10-13
---

# 0032 — Serve bare repositories with explicit checkouts

## Context

The Git server must let ordinary clients clone, fetch and push against the
SQLite repository inside a Durable Object. The user selected bare remote
semantics: receiving a push updates repository state; updating workspace files
is a separate operation.

Objects and direct refs already belong to the repository, but shared-store
opening and mutation services still require a primary checkout. Simply calling
the current ref CAS from receive-pack could move an attached checkout's HEAD
without updating its files or index. A synthetic empty checkout would hide that
ownership dependency instead of removing it.

Implementation is planned in the
[Smart HTTP server sprint](../archive/sprint-2026-10-13-git-smart-http-server.md);
the server and bare lifecycle are not implemented at this decision's acceptance.

## Decision

We will expose a repository-owned server surface over the existing SQLite Git
store, independent of checkout HEAD, index, filesystem and operation journals.

- A bare repository can exist with no checkouts. Attached checkouts are ordinary
  checkouts, not a required primary. Removing the last one preserves the repo.
  Existing workspace repositories retain their primary-checkout lifecycle.
- The server default branch is repository metadata, distinct from a checkout's
  HEAD. It may name an unborn branch. Changing a checkout does not change the
  branch advertised as the remote default.
- Pushes publish validated objects and direct refs. They do not update files.
  Update/delete of a branch attached to any checkout is refused, with the check
  repeated inside the final ref-publication transaction.
- The outer Worker resolves repository identity and enforces read/write
  permission on every HTTP request. Protocol codecs do not authenticate users;
  storage operations still enforce repository isolation and publication safety.
- Wire codecs, Git orchestration and storage stay in their existing Git layers.
  The DO composition consumes public Git APIs. The first example routes one
  repository to one DO without restricting the shared database's existing model.

## Consequences

The server can operate without a filesystem or artificial checkout, and a
network push cannot silently overwrite an agent's working files. Git storage and
protocol logic remain reusable outside the DO adapter.

Repository-owned ref/reflog, pack and maintenance services must be separated
from their current primary-checkout bindings. Registry, routing, cold reopen,
first/last checkout transitions and destruction need lifecycle witnesses.
Pushes to an attached branch require the caller to detach/switch that checkout
or push another branch; automatic worktree reconciliation is outside this design.

## Alternatives considered

- **Serve an existing workspace through its primary checkout.** Appropriate for
  a small export of a workspace, but retains a filesystem dependency and does
  not meet the selected bare ownership contract.
- **Update the active checkout during receive.** Appropriate for an explicit
  deployment workflow, but couples network publication to dirty files, index
  state and operation recovery. The user chose separate checkout updates.
- **Delegate to a filesystem Git server.** Appropriate where native Git storage
  is available, but adds another storage authority and does not serve the
  existing SQLite repository inside the Durable Object.
