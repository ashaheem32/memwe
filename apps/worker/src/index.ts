import { installVectorParser, close } from "@memwe/db";
import { Runner } from "./runner.js";
import { log } from "./log.js";

const runner = new Runner();

async function shutdown(signal: string): Promise<void> {
  log.info("signal received", { signal });
  await runner.stop();
  await close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", { reason: String(reason) });
});

await installVectorParser();
await runner.start();
