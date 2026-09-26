---
id: 97
title: Audit checkout modeled byte charges
blocked-by: []
---

# 97 — Audit checkout modeled byte charges

**Summary.** Decide which checkout retained-byte checks model JavaScript objects
and replace those with structural limits only after proving that every retained
collection has a real bound.

`checkout-support.ts` declares `CHECKOUT_PATH_FIXED_BYTES`,
`CHECKOUT_REMOVAL_BYTES`, `CHECKOUT_PRUNE_BYTES`, `CHECKOUT_UNMERGED_BYTES`
and `CHECKOUT_EXCLUDE_BYTES`;
`checkout-structure.ts` and `checkout-operation.ts` charge path length plus a
fixed object estimate. `initial-checkout.ts` similarly charges tracker seed
rows. These sites were outside the status/rm scope of 66. Check existing count
caps, path limits and mutation timing before removing any charge. Keep the
actual blob and removal-binding payload limits. Witness the first excess
retained item and checkout atomicity in the existing suites, and measure a
representative peak under the benchmark rules.
