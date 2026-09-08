# Release process

kompjutr uses Node.js 24 and npm 11 for maintainer checks and packaging. Five
public packages share one version:

1. `@kompjutr/sqlite`
2. `@kompjutr/drive`
3. `@kompjutr/git`
4. `@kompjutr/do`
5. `@kompjutr/local`

The first four have Worker-safe entry graphs. `@kompjutr/local` is Unix-only and
requires Node.js 24. There is no unscoped `kompjutr` package.

## Continuous integration

Pull requests and pushes to `main` run these gates on `ubuntu-latest`:

1. `npm ci`
2. `npm run check`
3. `npm run typecheck`
4. `npm run test:full`
5. `npm run build`
6. `npm run package:smoke`

The package smoke command rebuilds all package projects and runs `npm pack --json`
for each package. It rejects version drift, mismatched internal
dependency versions, unexpected artifacts, TypeScript source, and build state.
It installs the five exact tarballs together in a Node consumer and the four
Worker-facing tarballs in a separate consumer with no ambient Node types. It
verifies that every scoped package resolved from those tarballs, type-checks all
public entries, checks runtime imports, and proves the retired unscoped facade is
not available. The command removes its temporary consumers even when a check
fails.

`npm run test:full` covers every Vitest file in bounded root shards plus separate
filesystem, shell, and end-to-end slices. This keeps each worker pool short-lived
without weakening the exhaustive CI and release gate. The slices run
concurrently in a core-budgeted lane pool; `TEST_FULL_LANES` overrides the cap
on a busy or a larger machine.

Benchmarks are not CI gates. Run and report them only under the CPU lease defined
in `bench/CLAUDE.md`.

## Release sequence

Package publication is CI-only:

1. Set the same real version in all five package manifests. The placeholder
   `0.0.0` cannot be released.
2. Merge the version change after the normal CI gates pass.
3. Create and push the matching tag `v<package-version>`.
4. The release workflow checks that the tag and all five package versions
   match, repeats every CI gate, creates five tarballs, and tests those exact
   artifacts together. A retry skips an already published package only when the
   registry integrity matches the verified tarball, so a partial publication can
   resume without accepting different bytes under the same version.
5. GitHub holds the publish job at the protected `npm` environment. After its
   configured approval and protection rules pass, the job publishes the
   verified tarballs with provenance, in dependency order: SQLite, drive, Git,
   DO, local.

The `npm` GitHub environment, npm scope ownership, and trusted-publisher
configuration for each package are release prerequisites. The publish job uses
OIDC and npm 11; it does not use a long-lived npm token. Never run `npm publish`
from a maintainer workstation.
