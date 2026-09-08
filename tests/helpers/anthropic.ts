/**
 * A stand-in for the Messages API, at the HTTP boundary the SDK talks to.
 * Mocking the SDK itself would test our assumptions about it; this exercises
 * the real request builder and the real structured-output parser.
 */
export type Captured = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

export type FakeReply = {
  contexts?: Array<{ ord: number; context: string }>;
  text?: string;
  model?: string;
  stopReason?: string;
  stopDetails?: Record<string, unknown> | null;
  usage?: Partial<{
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  }>;
  status?: number;
  error?: { type: string; message: string };
};

/** Ords listed in the request's chunk block, in order. */
export function requestedOrds(body: Record<string, unknown>): number[] {
  const messages = body.messages as Array<{ content: Array<{ text: string }> }>;
  const text = messages[0]?.content.at(-1)?.text ?? "";
  return [...text.matchAll(/<chunk ord="(\d+)"/g)].map((m) => Number(m[1]));
}

export function fakeAnthropic(
  reply: (body: Record<string, unknown>, call: number) => FakeReply = defaultReply,
) {
  const calls: Captured[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url, headers, body });
    const r = reply(body, calls.length);
    if (r.error) {
      return new Response(JSON.stringify({ type: "error", error: r.error }), {
        status: r.status ?? 400,
        // The SDK retries 429/5xx on its own; keep that fast in tests.
        headers: { "content-type": "application/json", "retry-after-ms": "1" },
      });
    }
    const text = r.text ?? JSON.stringify({ contexts: r.contexts ?? [] });
    const message = {
      id: `msg_${calls.length}`,
      type: "message",
      role: "assistant",
      model: r.model ?? (body.model as string),
      content: [{ type: "text", text }],
      stop_reason: r.stopReason ?? "end_turn",
      stop_sequence: null,
      stop_details: r.stopDetails ?? null,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...r.usage,
      },
    };
    return new Response(JSON.stringify(message), {
      status: 200,
      headers: { "content-type": "application/json", "request-id": `req_${calls.length}` },
    });
  };
  return { fetch, calls };
}

/** Answers every requested ord with a recognisable context. */
export function defaultReply(body: Record<string, unknown>): FakeReply {
  return { contexts: requestedOrds(body).map((ord) => ({ ord, context: `ctx ${ord}` })) };
}
