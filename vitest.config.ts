// Standalone test config. Kept separate from vite.config.ts on purpose: the app
// build is owned by @lovable.dev/vite-tanstack-config and must not be disturbed.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/tests/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
