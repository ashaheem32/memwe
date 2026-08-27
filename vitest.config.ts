import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // exFAT volume: macOS writes `._x` sidecars that esbuild cannot parse.
    exclude: ["**/node_modules/**", "**/._*"],
    // These hit a real Postgres. Running them in parallel means two files
    // truncating the same tables under each other.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
