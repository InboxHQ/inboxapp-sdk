import {
  ApiError,
  CapabilityNotSupported,
  ConnectionError,
  Inboxapp,
  isApiError,
  RateLimited,
  SendUnconfirmed,
  ThreadNotFound,
  UnexpectedResponseError,
} from "@inboxapp/sdk";
import { describe, expect, it } from "vitest";
import { errorBody, mockFetch } from "./support.ts";

const BASE = "https://inboxapp.com/api/v2";

const client = (mock: ReturnType<typeof mockFetch>, options: { maxRetries?: number } = {}) =>
  new Inboxapp({ token: "ibt_test", fetch: mock.fetch, ...options });

describe("requests", () => {
  it("repeats the key for array query parameters", async () => {
    const mock = mockFetch({ body: { data: [], nextCursor: null } });

    await client(mock).threads.list({
      folder: "inbox",
      tag: ["vip", "hot lead"],
      expand: ["contact", "profile"],
      unassigned: true,
      limit: 10,
    });

    expect(mock.requests).toEqual([
      {
        method: "GET",
        url: `${BASE}/threads?folder=inbox&tag=vip&tag=hot%20lead&unassigned=true&expand=contact&expand=profile&limit=10`,
        headers: { accept: "application/json", authorization: "Bearer ibt_test" },
        body: undefined,
      },
    ]);
  });

  it("sends a JSON body and the Idempotency-Key header", async () => {
    const result = { message: { id: "m1" }, thread: { id: "t1" } };
    const mock = mockFetch({ status: 201, body: result }, { status: 200, body: result });
    const inbox = client(mock);
    const send = () =>
      inbox.messages.send({
        target: { type: "thread", threadId: "t1" },
        content: "hello",
        idempotencyKey: "order-4821-followup",
      });

    const created = await send();
    const replayed = await send();

    expect(mock.requests[0]).toEqual({
      method: "POST",
      url: `${BASE}/messages`,
      headers: {
        accept: "application/json",
        authorization: "Bearer ibt_test",
        "content-type": "application/json",
        "idempotency-key": "order-4821-followup",
      },
      body: { target: { type: "thread", threadId: "t1" }, content: "hello" },
    });
    expect(created).toEqual({ ...result, httpStatus: 201 });
    expect(replayed.httpStatus).toBe(200);
  });

  it("keeps null in a PATCH body and drops undefined", async () => {
    const mock = mockFetch({ body: { id: "c1" } });

    await client(mock).contacts.update({ contactId: "c1", notes: null, status: undefined });

    expect(mock.requests[0]).toMatchObject({
      method: "PATCH",
      url: `${BASE}/contacts/c1`,
      body: { notes: null },
    });
  });

  it("encodes path parameters and returns undefined for 204", async () => {
    const mock = mockFetch({ status: 204 });

    const result = await client(mock).contacts.addTag({ contactId: "c1", tagRef: "hot lead/2026" });

    expect(result).toBeUndefined();
    expect(mock.requests[0]).toMatchObject({
      method: "PUT",
      url: `${BASE}/contacts/c1/tags/hot%20lead%2F2026`,
    });
  });

  it("uses the configured base URL and per-request headers", async () => {
    const mock = mockFetch({ body: [] });
    const inbox = new Inboxapp({
      token: "ibt_test",
      fetch: mock.fetch,
      baseUrl: "http://127.0.0.1:3000/api/v2/",
    });

    await inbox.platforms.list(undefined, { headers: { "X-Trace": "abc" } });

    expect(mock.requests[0]).toMatchObject({
      url: "http://127.0.0.1:3000/api/v2/platforms",
      headers: { "x-trace": "abc" },
    });
  });
});

describe("errors", () => {
  it("throws the class of the error code", async () => {
    const mock = mockFetch({ status: 404, body: errorBody("threadNotFound") });

    const error = await client(mock)
      .threads.get({ threadId: "missing" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ThreadNotFound);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      name: "ThreadNotFound",
      code: "threadNotFound",
      status: 404,
      message: "threadNotFound happened",
      details: null,
      requestId: "req_test",
    });
  });

  it("narrows details by code", async () => {
    const mock = mockFetch({
      status: 422,
      body: errorBody("capabilityNotSupported", { capability: "message:edit" }),
    });

    const error = await client(mock)
      .messages.edit({ messageId: "m1", content: "fixed" })
      .catch((caught: unknown) => caught);

    expect(isApiError(error, "capabilityNotSupported")).toBe(true);
    expect(isApiError(error, "threadNotFound")).toBe(false);
    if (isApiError(error, "capabilityNotSupported")) {
      const capability: string = error.details.capability;
      expect(capability).toBe("message:edit");
    }
    if (error instanceof CapabilityNotSupported) {
      expect(error.details.capability).toBe("message:edit");
    }
  });

  it("keeps a code it does not know as a plain ApiError", async () => {
    const mock = mockFetch({ status: 418, body: errorBody("teapotRequired", { cups: 2 }) });

    const error = await client(mock)
      .team.get()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).constructor).toBe(ApiError);
    expect(error).toMatchObject({ code: "teapotRequired", status: 418, details: { cups: 2 } });
  });

  it("reports a response without the error body", async () => {
    const mock = mockFetch({ status: 502, body: "<html>Bad gateway</html>" });

    const error = await client(mock, { maxRetries: 0 })
      .team.get()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(error).toMatchObject({ status: 502, body: "<html>Bad gateway</html>" });
  });

  it("wraps a failed fetch", async () => {
    const inbox = new Inboxapp({
      token: "ibt_test",
      maxRetries: 0,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    await expect(inbox.team.get()).rejects.toBeInstanceOf(ConnectionError);
  });
});

describe("pagination", () => {
  const pages = [
    { data: [{ id: "t1" }, { id: "t2" }], nextCursor: "c1" },
    { data: [{ id: "t3" }], nextCursor: "c2" },
    { data: [], nextCursor: null },
  ];

  it("passes nextCursor back as cursor and keeps the filters", async () => {
    const mock = mockFetch(...pages.map((body) => ({ body })));

    const ids: string[] = [];
    for await (const thread of client(mock).threads.list.items({ folder: "all", limit: 2 })) {
      ids.push(thread.id);
    }

    expect(ids).toEqual(["t1", "t2", "t3"]);
    expect(mock.requests.map((request) => request.url)).toEqual([
      `${BASE}/threads?folder=all&limit=2`,
      `${BASE}/threads?folder=all&limit=2&cursor=c1`,
      `${BASE}/threads?folder=all&limit=2&cursor=c2`,
    ]);
  });

  it("yields whole pages", async () => {
    const mock = mockFetch(...pages.map((body) => ({ body })));

    const sizes: number[] = [];
    for await (const page of client(mock).threads.list.pages()) sizes.push(page.data.length);

    expect(sizes).toEqual([2, 1, 0]);
  });

  it("replays events from lastSeq while hasMore is true", async () => {
    const mock = mockFetch(
      { body: { data: [{ id: "e1", seq: 11 }], lastSeq: 14, hasMore: true } },
      { body: { data: [{ id: "e2", seq: 15 }], lastSeq: 15, hasMore: false } },
    );

    const ids: string[] = [];
    for await (const event of client(mock).events.list.items({
      afterSeq: 10,
      type: ["tag.created"],
    })) {
      ids.push(event.id);
    }

    expect(ids).toEqual(["e1", "e2"]);
    expect(mock.requests.map((request) => request.url)).toEqual([
      `${BASE}/events?afterSeq=10&type=tag.created`,
      `${BASE}/events?afterSeq=14&type=tag.created`,
    ]);
  });
});

describe("retries", () => {
  const rateLimited = {
    status: 429,
    headers: { "retry-after": "0" },
    body: errorBody("rateLimited", {
      window: "minute",
      limit: 300,
      resetAt: "2026-09-14T10:33:00.000Z",
    }),
  };
  const internal = { status: 500, body: errorBody("internal"), headers: { "retry-after": "0" } };
  const send = (inbox: Inboxapp, idempotencyKey?: string) =>
    inbox.messages.send({
      target: { type: "thread", threadId: "t1" },
      content: "hi",
      idempotencyKey,
    });

  it("waits for Retry-After and tries again when rate limited", async () => {
    const mock = mockFetch(rateLimited, { body: { id: "team" } });

    await expect(client(mock).team.get()).resolves.toEqual({ id: "team" });
    expect(mock.requests).toHaveLength(2);
  });

  it("gives up after maxRetries", async () => {
    const mock = mockFetch(rateLimited);

    await expect(client(mock, { maxRetries: 1 }).team.get()).rejects.toBeInstanceOf(RateLimited);
    expect(mock.requests).toHaveLength(2);
  });

  it("does not repeat a send without an Idempotency-Key after a server error", async () => {
    const mock = mockFetch(internal);

    await expect(send(client(mock))).rejects.toMatchObject({ code: "internal" });
    expect(mock.requests).toHaveLength(1);
  });

  it("repeats a send that carries an Idempotency-Key", async () => {
    const mock = mockFetch(internal, { status: 201, body: { message: {}, thread: {} } });

    await expect(send(client(mock), "key-1")).resolves.toMatchObject({ httpStatus: 201 });
    expect(mock.requests).toHaveLength(2);
  });

  it("never repeats sendUnconfirmed", async () => {
    const mock = mockFetch({
      status: 502,
      body: errorBody("sendUnconfirmed", { messageId: "m1" }),
    });

    await expect(send(client(mock), "key-1")).rejects.toBeInstanceOf(SendUnconfirmed);
    expect(mock.requests).toHaveLength(1);
  });

  it("fails instead of waiting longer than a minute", async () => {
    const mock = mockFetch({
      status: 429,
      body: errorBody("platformRateLimited", { retryAfterSeconds: 900 }),
    });

    await expect(client(mock).threads.typing({ threadId: "t1" })).rejects.toMatchObject({
      code: "platformRateLimited",
    });
    expect(mock.requests).toHaveLength(1);
  });
});
