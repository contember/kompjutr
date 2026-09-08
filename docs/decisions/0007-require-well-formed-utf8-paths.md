---
id: 0007
title: Require well-formed UTF-8 paths
status: accepted
date: 2026-08-26
---

# 0007 — Require well-formed UTF-8 paths

## Context

Git tree names are byte strings, but this runtime exposes filesystem, status,
tree, and client paths as JavaScript strings. Tree parsing originally used a
non-fatal UTF-8 decoder, so distinct invalid byte sequences collapsed to the
same replacement-character string, and framing-safe porcelain output could not
recover the original bytes afterwards.

The filesystem has the same problem from the other direction. A lone surrogate
stores as WTF-8 through a JSON binding and as U+FFFD through a direct bind, so
the name read back is not the name written.

The alternative is a byte-path model across the filesystem, index, tree walk,
status rows, and public clients. Nothing is deployed, so we can instead make the
existing string boundary explicit and reject data that cannot cross it
losslessly.

## Decision

Paths must be well-formed UTF-8 in both runtime compositions, and each drive
enforces it at one chokepoint.

- Git: every tree ingestion and authoritative tree-row read decodes names
  fatally and fails with a stable `EUNSUPPORTED` before publishing an invalid
  loose or packed tree.
- DO filesystem: `packages/do/src/fs/store/resolve.ts` is the sole producer of a
  `RealPath` and therefore the single place a caller path is checked.
- Local disk: `packages/local/src/paths.ts` resolves every virtual path before
  host access and rejects malformed names and escaping symlinks.

A caller path that is not well-formed fails with `EINVAL`.

Public paths remain JavaScript strings.

## Consequences

- Hostile but well-formed names stay lossless and can match Git's quoted and
  NUL-framed status output.
- An invalid name fails closed in either domain instead of silently changing
  identity.
- The two domains reject the same input for the same reason through separate
  helpers, because the filesystem must not depend on the Git layer.
- Repositories that require arbitrary byte paths remain unsupported until the
  public path model is redesigned.

## Alternatives considered

- Carry raw bytes only in porcelain formatters. Too late: tree ingestion has
  already lost the identity.
- Add parallel string and byte paths to status only. This leaves the
  filesystem, index, checkout, and merge boundaries inconsistent.
- Redesign every path boundary now. That is a separate architectural project,
  tracked in [backlog 59](../backlog/59-byte-preserving-git-paths.md).
