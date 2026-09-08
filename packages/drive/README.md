# @kompjutr/drive

Synchronous filesystem contracts used by `@kompjutr/git`.

`GitDrive` covers bounded reads, writes, discovery, and ordered scans. A drive
may expose private capability receipts for optimized integrations. Generic Git
uses the public fallback when those capabilities are absent.

The package has no filesystem implementation and no Node.js imports.
