---
id: 05
title: Establish CI and release gates
blocked-by: []
---

# 05 — Establish CI and release gates

**Summary.** Add reproducible automated gates for changes and package artifacts
before the experimental package moves toward a release.

## Problem

The repository has check, typecheck, test, and build scripts but no checked-in
GitHub Actions workflow. The package remains at `0.0.0`, and no automated smoke
test proves that its declared exports and optional compatibility peer work from
the packed artifact.

## Approach / acceptance

- Run formatting/lint checks, typecheck, the functional suite, and build on pull
  requests and the default branch.
- Build a package tarball and smoke-test every public export from an isolated
  consumer, both with and without the optional compatibility peer where useful.
- Keep timing and benchmark gates separate from ordinary CI unless their runner
  isolation makes the result meaningful and reproducible.
- Define a tag-driven release gate in CI. Do not publish from a developer machine.
- Document the supported runtime and release procedure once the gates pass.

## Touch points

`.github/workflows/`, `package.json`, package smoke-test fixtures, `README.md`,
`docs/reference/`
