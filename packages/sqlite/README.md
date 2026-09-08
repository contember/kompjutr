# @kompjutr/sqlite

Shared synchronous SQLite contracts and value codecs for kompjutr runtimes.

This package defines `SqlDatabase`, cursor normalization, stable SQLite error
mapping, shared routing limits, and BLOB codecs. It contains no Node.js imports
and can be used from Cloudflare Workers.

Most applications use it indirectly through `@kompjutr/do` or
`@kompjutr/local`. Adapter authors can implement `SqlDatabase` and pass it to
`@kompjutr/git`.
