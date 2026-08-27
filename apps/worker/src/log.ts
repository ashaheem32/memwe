/**
 * Structured logs, one trace id threaded from the HTTP request through
 * every stage. You will be debugging across the seam constantly and a
 * grep for one traceId is the difference between five minutes and an hour.
 */
type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

function emit(level: Level, msg: string, fields: Record<string, unknown>): void {
  if (ORDER[level] < MIN) return;
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

export type Logger = {
  debug: (msg: string, f?: Record<string, unknown>) => void;
  info: (msg: string, f?: Record<string, unknown>) => void;
  warn: (msg: string, f?: Record<string, unknown>) => void;
  error: (msg: string, f?: Record<string, unknown>) => void;
  child: (f: Record<string, unknown>) => Logger;
};

export function logger(base: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, f) => emit("debug", m, { ...base, ...f }),
    info: (m, f) => emit("info", m, { ...base, ...f }),
    warn: (m, f) => emit("warn", m, { ...base, ...f }),
    error: (m, f) => emit("error", m, { ...base, ...f }),
    child: (f) => logger({ ...base, ...f }),
  };
}

export const log = logger({ svc: "worker" });
