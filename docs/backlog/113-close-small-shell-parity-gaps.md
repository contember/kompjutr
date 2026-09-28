---
id: 113
title: Close small shell parity gaps found in the 2026-09-28 sprint
---

# 113 — Close small shell parity gaps found in the 2026-09-28 sprint

**Summary.** Reproduced divergences from Bash and the reference tools that the
sprint left alone. Tier S for the silent ones, otherwise B.

## Problem

- `printf -- 'x\n'` prints `--` and drops the format (Bash treats `--` as the
  end of options). Silent.
- `find . -name sub | xargs rg -l foo` misses `./sub/z.ts` (the fused search
  treats `-name` as a file filter); `find sub | xargs grep -l foo` exits 0 where
  Bash exits 123 with `Is a directory`. Silent.
- A redirection error prints to the shell's stderr instead of the stderr bound
  so far (`echo a 2>/dev/null > nodir/x` prints a message; Bash prints none).
- `cat < missing` prints `cat: ENOENT: …` instead of Bash's
  `bash: line 1: missing: No such file or directory`.
- `> file` alone is a syntax error; Bash creates the file.
- `eval`, `source`, `.`, `read`, and `shift` report `command not found` instead
  of an explicit refusal.
- `cat` exits 1 with several missing operands; uutils `cat` exits 2.
- `which cd` and `which :` print `/usr/bin/<name>`; `which` finds nothing for a
  builtin.
- A caller env with a non-default `IFS` is ignored for splitting.

## Approach / acceptance

One parity case per bullet, compared with Bash; admit the form or refuse it
explicitly.

## Touch points

`commands/printf.ts`, `plan/fusions.ts`, `exec/redirections.ts`,
`commands/read.ts`, `parse/simple.ts`, `commands/text.ts`.

<!-- Origin: sprint-2026-09-28-shell-surface-expansion run log. -->
