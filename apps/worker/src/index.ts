import { close, installVectorParser } from "@memwe/db";
import { warmTokenizer } from "./chunk/tokens.js";
import { disposeOcr } from "./extract/ocr.js";
import { disposeBrowser } from "./fetch/browser.js";
import { log } from "./log.js";
import { Runner } from "./runner.js";

const runner = new Runner();

async function shutdown(signal: string): Promise<void> {
  log.info("signal received", { signal });
  await runner.stop();
  await disposeOcr();
  await disposeBrowser();
  await close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { reason: String(reason) });
});

await installVectorParser();
await warmTokenizer();
await runner.start();
