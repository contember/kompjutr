# Bare Git remote in a Durable Object

One URL, `https://your-worker.example/project.git`, maps to one SQLite Durable
Object. The application stores the repository ID in its own singleton table.
A cold start opens that ID. No workspace or filesystem is created.

Install the published `@kompjutr/do` package in your deployment project. Configure
`GIT_READ_TOKEN` and `GIT_WRITE_TOKEN` as Worker secrets through your deployment
pipeline. Use HTTPS and a Git credential helper: any username is accepted, and
the password is the read or write token. A write token also permits reads.
Do not put tokens in remote URLs or commit them to configuration.

```sh
git remote add durable https://your-worker.example/project.git
git push durable main
git clone https://your-worker.example/project.git
```

The outer Worker checks credentials for every discovery and POST before looking
up a Durable Object. Tokens grant access to every repository in this minimal
example; replace that policy with your application authorization if needed.
Repository names are lowercase ASCII slugs of at most 63 characters.

Push updates objects and refs only. Checkouts are separate. The incoming pack
limit is 256 MiB. Durable alarms advance bounded maintenance and expire
abandoned transfers. Requests preserve an earlier pending alarm, so continuous
traffic cannot postpone cleanup. Deploy through CI using `wrangler.jsonc`; this example does
not provision secrets or deploy itself.

The `enable_request_signal` compatibility flag is required for disconnect
cleanup through `Request.signal`; a compatibility date alone does not enable
it. See [Cloudflare incoming request cancellation](https://developers.cloudflare.com/changelog/post/2025-05-22-handle-request-cancellation/).

The example configures a 300,000 ms CPU ceiling per request because large
repository publication can exceed the default 30 seconds. Yielding does not
reset CPU accounting. This is a configured ceiling, not evidence of production
capacity; see [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
