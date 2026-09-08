# @kompjutr/do

Durable Object SQLite filesystem and Git workspace composition.

```ts
import { Workspace } from "@kompjutr/do";
import { createGit } from "@kompjutr/git";

const workspace = new Workspace({ storage: ctx.storage, git: createGit() });
await workspace.git.init();
workspace.fs.writeFileSync("/README.md", "# project\n");
```

Subpaths expose the raw filesystem (`@kompjutr/do/fs`), bounded shell
(`@kompjutr/do/shell`), explicit Git shell command
(`@kompjutr/do/git-shell`), and testing contracts (`@kompjutr/do/testing`).
Worker-facing entries use the Workers-supported `node:buffer` and `node:zlib`
compatibility modules. Enable the `nodejs_compat` compatibility flag.
