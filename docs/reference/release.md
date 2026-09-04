# Release process

kompjutr uses Node.js 24 and npm 11 for maintainer checks and packaging. The
published JavaScript targets Cloudflare Workers with SQLite-backed Durable
Objects. The package has no runtime peer dependency; every entry must load on
its own.

## Continuous integration

Pull requests and pushes to `main` run these gates on `ubuntu-latest`:

1. `npm ci`
2. `npm run check`
3. `npm run typecheck`
4. `npm run test:full`
5. `npm run build`
6. `npm run package:smoke`

The package smoke command rebuilds the package, runs `npm pack` once, and installs
that exact tarball into a temporary consumer, which imports `kompjutr`,
`kompjutr/fs`, `kompjutr/git`, `kompjutr/shell`, and `kompjutr/testing`. The
command removes the consumer even when a check fails.

`npm run test:full` covers every Vitest file in bounded root shards plus separate
filesystem, shell, and end-to-end slices. This keeps each worker pool short-lived
without weakening the exhaustive CI and release gate. The slices run
concurrently in a core-budgeted lane pool; `TEST_FULL_LANES` overrides the cap
on a busy or a larger machine.

Benchmarks are not CI gates. Run and report them only under the CPU lease defined
in `bench/CLAUDE.md`.

## Release sequence

Package publication is CI-only:

1. Set a real package version. The placeholder `0.0.0` cannot be released.
2. Merge the version change after the normal CI gates pass.
3. Create and push the matching tag `v<package-version>`.
4. The release workflow checks that the tag and package version match, repeats
   every CI gate, creates one tarball, and tests that exact artifact.
5. GitHub holds the publish job at the protected `npm` environment. After its
   configured approval and protection rules pass, the job publishes the verified
   tarball to npm with provenance.

The `npm` GitHub environment and npm trusted-publisher configuration are release
prerequisites. The publish job uses OIDC and npm 11; it does not use a long-lived
npm token. Never run `npm publish` from a maintainer workstation.
