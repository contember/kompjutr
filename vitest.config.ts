import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@kompjutr/git/do-fs": fileURLToPath(
        new URL("./packages/git/src/do-fs/index.ts", import.meta.url),
      ),
      "@kompjutr/do/git-shell": fileURLToPath(
        new URL("./packages/do/src/git-shell.ts", import.meta.url),
      ),
      "@kompjutr/do/testing": fileURLToPath(
        new URL("./packages/do/src/testing.ts", import.meta.url),
      ),
      "@kompjutr/do/shell": fileURLToPath(
        new URL("./packages/do/src/shell/index.ts", import.meta.url),
      ),
      "@kompjutr/do/fs": fileURLToPath(new URL("./packages/do/src/fs/index.ts", import.meta.url)),
      "@kompjutr/sqlite": fileURLToPath(new URL("./packages/sqlite/src/index.ts", import.meta.url)),
      "@kompjutr/drive": fileURLToPath(new URL("./packages/drive/src/index.ts", import.meta.url)),
      "@kompjutr/git": fileURLToPath(new URL("./packages/git/src/index.ts", import.meta.url)),
      "@kompjutr/do": fileURLToPath(new URL("./packages/do/src/index.ts", import.meta.url)),
      "@kompjutr/local": fileURLToPath(new URL("./packages/local/src/index.ts", import.meta.url)),
      // @cloudflare/computer imports `cloudflare:workers` at module scope.
      // Node tests only need the class identities, not the runtime.
      "cloudflare:workers": fileURLToPath(
        new URL("./tests/helpers/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The alias above only applies to modules vite transforms, and
    // dependencies are externalised by default.
    server: { deps: { inline: ["@cloudflare/computer"] } },
  },
});
