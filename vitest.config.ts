import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Tests read the same .env the apps do. Without this they silently run on
// code defaults, which is how a misconfiguration passes CI and fails in
// the one environment that matters.
if (existsSync(".env")) process.loadEnvFile(".env");
// Never let a key in the environment make a pipeline test spend on a model.
// Tests that want the real thing construct the client themselves and opt in
// (see tests/context-live.test.ts); everything else gets the heading path.
process.env.CONTEXT_PROVIDER = "none";

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
