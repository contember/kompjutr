---
id: 45
title: Make porcelain output framing-safe
blocked-by: []
---

# 45 — Make porcelain output framing-safe

**Summary.** Tier S. The status formatters emit raw paths joined by newlines, so
a path containing a newline produces output that cannot be parsed back — and
differs from Git — with nothing to warn the caller.

## Problem

`formatPorcelainV1()` (`src/core/ops/status.ts:712`) writes
`` `${entry.index}${entry.worktree} ${entry.path}` `` and joins the lines with
newlines. Nothing quotes. `formatShort()` (`src/core/ops/status.ts:731`)
delegates to it, and its own comment concedes the point — the two "differ only
on colour and path quoting", and the quoting is the missing half.

Git quotes such a path C-style in porcelain v1 and short (subject to
`core.quotePath`), and offers `-z` to drop quoting in favour of NUL framing.
kompjutr does neither, and `core.quotePath` is one of the keys stored verbatim
with no effect.

The path is reachable: `git_tree_entries.name_bytes` accepts any 1–2200 bytes,
and `comparePaths` orders them by UTF-8 bytes without complaint. A rename row is
worse than a plain one — it uses ` -> ` as a separator, which a path may also
contain.

This is tier S rather than tier A because the caller gets a plausible line
either way. `diffSummary()` is structured and unaffected; the defect is in the
text formatters and in the missing `-z` mode a machine caller would reach for.

## Approach / acceptance

- Implement Git's C-style path quoting for v1, v2 and short, gated on
  `core.quotePath` (default on), matching Git byte for byte — including the
  octal escapes for non-UTF-8 bytes and the escaped `"` `\` and control chars.
- Add a `-z` mode to each formatter: no quoting, NUL termination, and the rename
  source emitted as its own NUL-terminated field, as Git does.
- Establish the acceptance envelope first: a test that writes each hostile path
  through the filesystem and commits it, so the item states what kompjutr
  actually accepts rather than assuming.
- Real Git parity tests against real `git status` over a path with a newline, a
  double quote, a backslash, a non-UTF-8 byte sequence, and a leading and
  trailing space — each in v1, v2 and short, and each again under `-z`.

## Touch points

`src/core/ops/status.ts`, `src/git/client.ts`, `src/compat/computer/client.ts`,
`tests/status.test.ts`, `tests/git-upstream-parity.test.ts`,
`docs/reference/git-support.md`

<!-- Origin: docs/reference/git-support.md#reference-workload-coverage -->
