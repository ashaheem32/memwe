/**
 * Error taxonomy. Two axes that matter: is it the caller's fault, and is
 * it worth retrying. The runner reads `retryable` to decide between
 * backoff and dead-letter — get this wrong and you either hammer a
 * permanently-broken PDF forever or drop a transient timeout.
 */
export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "quota_exceeded"
  | "upstream_failed"
  | "unsupported_content"
  | "internal";

const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  quota_exceeded: 429,
  upstream_failed: 502,
  unsupported_content: 415,
  internal: 500,
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "rate_limited",
  "upstream_failed",
  "internal",
]);

export class MemweError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "MemweError";
    this.code = code;
    this.status = HTTP_STATUS[code];
    this.retryable = RETRYABLE.has(code);
    this.detail = detail;
  }

  toJSON(): Record<string, unknown> {
    return { error: { code: this.code, message: this.message, ...(this.detail ?? {}) } };
  }
}

/** Unknown throwables are retryable — assume transient until proven otherwise. */
export function isRetryable(err: unknown): boolean {
  return err instanceof MemweError ? err.retryable : true;
}
