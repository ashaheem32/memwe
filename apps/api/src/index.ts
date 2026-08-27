import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as cache from "@memwe/cache";
import { HealthResponse, MemweError } from "@memwe/contracts";
import { close as closeDb, installVectorParser, pool } from "@memwe/db";
import { ZodError } from "zod";
import type { Principal } from "./auth.js";
import { authenticate } from "./auth.js";
import { documents } from "./routes/documents.js";

type Env = { Variables: { principal: Principal; traceId: string } };

const app = new OpenAPIHono<Env>({
  // Zod failures from route schemas arrive here rather than as thrown
  // errors, so they need the same envelope as everything else.
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: { code: "invalid_request", message: "validation failed" },
          issues: result.error.issues,
          traceId: c.get("traceId"),
        },
        400,
      );
    }
    return undefined;
  },
});

app.use("*", async (c, next) => {
  const traceId = c.req.header("x-trace-id") ?? randomUUID();
  c.set("traceId", traceId);
  c.header("x-trace-id", traceId);
  const started = Date.now();
  await next();
  process.stdout.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      svc: "api",
      msg: "request",
      traceId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Date.now() - started,
    })}\n`,
  );
});

app.get("/healthz", async (c) => {
  const [postgres, redis] = await Promise.all([
    pool.query("select 1").then(
      () => true,
      () => false,
    ),
    cache.ping(),
  ]);
  // Redis is a cache, not a dependency — it degrades to in-process, so a
  // Redis outage is reported but does not fail the healthcheck.
  const body = HealthResponse.parse({ ok: postgres, postgres, redis });
  return c.json(body, postgres ? 200 : 503);
});

app.use("/v1/*", async (c, next) => {
  c.set("principal", await authenticate(c.req.header("Authorization")));
  await next();
});

app.route("/v1/documents", documents);

app.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "memwe",
    version: "0.0.0",
    description:
      "A memory layer for AI agents. This document is generated from the same Zod " +
      "schemas that validate every request, so the two cannot drift.",
  },
  servers: [{ url: "http://localhost:8080", description: "local" }],
});

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description: "An API key from the console. Send as `Authorization: Bearer <key>`.",
});

app.onError((err, c) => {
  const traceId = c.get("traceId");
  if (err instanceof MemweError) {
    return c.json({ ...err.toJSON(), traceId }, err.status as 400);
  }
  if (err instanceof ZodError) {
    return c.json(
      {
        error: { code: "invalid_request", message: "validation failed" },
        issues: err.issues,
        traceId,
      },
      400,
    );
  }
  process.stderr.write(
    JSON.stringify({ level: "error", svc: "api", msg: "unhandled", traceId, err: String(err) }) +
      "\n",
  );
  return c.json({ error: { code: "internal", message: "internal error" }, traceId }, 500);
});

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
