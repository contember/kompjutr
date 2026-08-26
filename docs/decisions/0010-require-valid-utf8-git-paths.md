---
id: 0010
title: Require valid UTF-8 Git paths
status: accepted
date: 2026-08-26
---

# 0010 — Require valid UTF-8 Git paths

## Context

Git tree names are byte strings, but kompjutr exposes filesystem, status, tree,
and client paths as JavaScript strings. Tree parsing currently uses a non-fatal
UTF-8 decoder, so distinct invalid byte sequences can collapse to the same
replacement-character string. Framing-safe porcelain output cannot recover the
original bytes after that loss.

The alternative is a byte-path model across the filesystem, index, tree walk,
status rows, public clients, and compatibility adapters. Nothing is deployed, so
we can instead make the existing string boundary explicit and reject data that
cannot cross it losslessly.

## Decision

Kompjutr Git paths must be valid UTF-8. Every tree ingestion and authoritative
tree-row read must decode names fatally and fail with a stable `EUNSUPPORTED`
before publishing an invalid loose or packed tree. Public paths remain strings.

## Consequences

Hostile valid UTF-8 names remain lossless and can match Git's quoted and
NUL-framed status output. Invalid Git tree names fail closed instead of silently
changing identity. Repositories that require arbitrary byte paths remain
unsupported until the public path model is redesigned.

## Alternatives considered

- Carry raw bytes only in porcelain formatters. This is too late because tree
  ingestion has already lost identity.
- Add parallel string and byte paths to status. This leaves filesystem, index,
  checkout, merge, and compatibility boundaries inconsistent.
- Redesign every path boundary now. That is a separate architectural project and
  is tracked in backlog item 59.

