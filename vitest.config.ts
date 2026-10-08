import { defineConfig } from "vitest/config";

// The package exports its TypeScript source under the `bun` condition, so
// tests import `@inboxapp/sdk` by name and run against src without a build.
const conditions = ["bun", "import", "module", "node", "default"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    include: ["test/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
