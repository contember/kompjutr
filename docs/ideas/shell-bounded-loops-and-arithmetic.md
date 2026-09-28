# Shell: bounded loops and arithmetic

The 2026-09-28 shell sprint admitted only loops with a structural bound
(ADR-0027). Agents also write:

- `while read -r line; do …; done < file` — bounded by the input, but needs
  `read` and a loop whose bound is its stdin.
- `$((i + 1))`, `((n++))`, and `for ((i = 0; i < n; i++))` — arithmetic
  expansion is refused today.
- `awk '{ for (i = 1; i <= NF; i++) … }'` — the most common awk loop. A C-style
  `for` whose bound is `NF`, `length(arr)`, `NR`, or a literal, with the loop
  variable not assigned in the body, has a structural bound.
- `jq` on inputs above about 6 MB: each input is charged at its parsed size,
  and a 5 MB lockfile already peaks at 14.8 MB of the 16 MiB budget.

Each needs a bound that names a real failure (see backlog 111) before it can be
admitted.
