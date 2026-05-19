import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
    // Rules tests require the Firestore emulator — run via `npm run test:rules` instead
    exclude: ["src/firestore.rules.test.ts"],
  },
});
