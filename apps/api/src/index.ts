import { serve } from "@hono/node-server";
import * as cache from "@memwe/cache";
import { close as closeDb, installVectorParser } from "@memwe/db";
import { app } from "./app.js";

await installVectorParser();
const port = Number(process.env.PORT ?? 8080);
const server = serve({ fetch: app.fetch, port }, (info) => {
  process.stdout.write(
    `${JSON.stringify({ level: "info", svc: "api", msg: "listening", port: info.port })}\n`,
  );
});

const shutdown = (): void => {
  server.close(() => {
    void Promise.allSettled([closeDb(), cache.close()]).then(() => process.exit(0));
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
