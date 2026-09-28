---
id: 114
title: Share one uutils argument parser across shell commands
---

# 114 — Share one uutils argument parser across shell commands

**Summary.** Four units wrote their own clap-style argv parser. Removal.

## Problem

`commands/uutils/arguments.ts`, `commands/columns/clap.ts`,
`commands/system/clap.ts`, and `commands/links/options.ts` each reproduce
uutils' argument errors (long-option prefixes, "did you mean" tips, exact
texts). They differ in which quirks they model.

## Approach / acceptance

Keep one parser in `commands/uutils/`, move the others onto it, and delete the
copies. Every existing parity suite passes unchanged.

## Touch points

`commands/{uutils,columns,system,links}/`.

<!-- Origin: sprint-2026-09-28-shell-surface-expansion run log (C1, C2, C3, C5). -->
