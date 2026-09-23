# @kompjutr/drive

Synchronous filesystem contracts used by `@kompjutr/git`.

`GitDrive` covers bounded reads, writes, discovery, and ordered scans. Every
drive streams `scanStream` in Git path order over a resolved root; Git walks,
hashes, and dirty checks consume only that stream.

The package has no filesystem implementation and no Node.js imports.
