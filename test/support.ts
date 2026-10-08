export interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/** A `fetch` that records each request and answers from `replies`, repeating the last one. */
export function mockFetch(...replies: Array<Reply | ((request: Recorded) => Reply)>) {
  const requests: Recorded[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => (headers[name] = value));
    const request: Recorded = {
      method: init?.method ?? "GET",
      url: String(input),
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const next = replies[Math.min(requests.length - 1, replies.length - 1)]!;
    return toResponse(typeof next === "function" ? next(request) : next);
  };
  return { fetch, requests };
}

export function toResponse(reply: Reply): Response {
  const status = reply.status ?? 200;
  const body =
    reply.body === undefined || status === 204
      ? null
      : typeof reply.body === "string"
        ? reply.body
        : JSON.stringify(reply.body);
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...reply.headers },
  });
}

export const errorBody = (code: string, details: unknown = null) => ({
  code,
  message: `${code} happened`,
  details,
  requestId: "req_test",
});
