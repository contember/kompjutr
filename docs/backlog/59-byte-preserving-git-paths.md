---
id: 59
title: Add byte-preserving Git paths
blocked-by: []
---

# 59 — Add byte-preserving Git paths

**Summary.** Replace the UTF-8-only string envelope with a lossless byte-path
model for repositories that contain non-UTF-8 tree names. Effort XL.

## Problem

Git permits arbitrary non-NUL bytes in tree entry names. Kompjutr currently uses
JavaScript strings across its filesystem, index, tree walk, status, clients, and
compatibility adapters. ADR-0010 makes this boundary safe by rejecting invalid
UTF-8, but it cannot represent every valid Git repository.

## Approach / acceptance

- Design one canonical byte-preserving path type and ordering contract across
  SQLite, filesystem, tree, index, checkout, merge, status, and public clients.
- Define compatibility behaviour for string-only consumers.
- Ingest, round-trip, mutate, quote, and NUL-frame adversarial non-UTF-8 paths
  byte-for-byte against real Git without aliases or replacement characters.

## Touch points

All path-bearing core, filesystem, SQLite, client, compatibility, and protocol
surfaces.

<!-- Origin: ADR-0010 and sprint-2026-08-26-git-boundary-correctness. -->

