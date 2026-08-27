import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { ZodError } from "zod";
import { pool, installVectorParser, close } from "@memwe/db";
import { MemweError } from "@memwe/contracts";
import { authenticate } from "./auth.js";
import type { Principal } from "./auth.js";
import { documents } from "./routes/documents.js";

type Env = { Variables: { principal: Principal; traceId: string } };

const app = new Hono<Env>();

app.use("*", async (c, next) => {
  const traceId = c.req.header("x-trace-id") ?? randomUUID();
  c.set("traceId", traceId);
  c.header("x-trace-id", traceId);
  const started = Date.now();
  await next();
  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      svc: "api",
      msg: "request",
      traceId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Date.now() - started,
    }) + "\n",
  );
});

app.get("/healthz", async (c) => {
  try {
    await pool.query("select 1");
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false }, 503);
  }
});

app.use("/v1/*", async (c, next) => {
  c.set("principal", await authenticate(c.req.header("Authorization")));
  await next();
});

app.route("/v1/documents", documents);

app.onError((err, c) => {
  const traceId = c.get("traceId");
  if (err instanceof MemweError) return c.json({ ...err.toJSON(), traceId }, err.status as 400);
  if (err instanceof ZodError) {
    return c.json(
      { error: { code: "invalid_request", message: "validation failed", issues: err.issues }, traceId },
      400,
    );
  }
  console.error(JSON.stringify({ level: "error", msg: "unhandled", traceId, err: String(err) }));
  return c.json({ error: { code: "internal", message: "internal error" }, traceId }, 500);
});

await installVectorParser();
const port = Number(process.env["PORT"] ?? 8080);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(JSON.stringify({ level: "info", svc: "api", msg: "listening", port: info.port }));
});

const shutdown = (): void => {
  server.close(() => void close().then(() => process.exit(0)));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
