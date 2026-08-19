import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
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
