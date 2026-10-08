import * as Inboxapp from "@inboxapp/sdk/effect";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";
import { errorBody, toResponse, type Recorded, type Reply } from "./support.ts";

const BASE = "https://inboxapp.com/api/v2";

/** An `HttpClient` that records each request and answers from `replies`, repeating the last one. */
function mockHttpClient(...replies: Reply[]) {
  const requests: Recorded[] = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        const body = request.body;
        requests.push({
          method: request.method,
          url: url.href,
          headers: { ...request.headers },
          body:
            body._tag === "Uint8Array"
              ? JSON.parse(new TextDecoder().decode(body.body))
              : undefined,
        });
        const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!;
        return HttpClientResponse.fromWeb(request, toResponse(reply));
      }),
    ),
  );
  return { layer, requests };
}

const credentials = Inboxapp.fromToken({ token: Redacted.make("ibt_test") });

const run = <A, E>(
  effect: Effect.Effect<A, E, Inboxapp.InboxappOpContext>,
  mock: ReturnType<typeof mockHttpClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(mock.layer, credentials))));

describe("requests", () => {
  it("repeats the key for array query parameters", async () => {
    const mock = mockHttpClient({ body: { data: [], nextCursor: null } });

    const page = await run(
      Inboxapp.threads.list({
        folder: "inbox",
        tag: ["vip", "hot lead"],
        expand: ["contact", "profile"],
        unassigned: true,
        limit: 10,
      }),
      mock,
    );

    expect(page).toEqual({ data: [], nextCursor: null });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]).toMatchObject({
      method: "GET",
      url: `${BASE}/threads?folder=inbox&tag=vip&tag=hot%20lead&unassigned=true&expand=contact&expand=profile&limit=10`,
      headers: { accept: "application/json", authorization: "Bearer ibt_test" },
      body: undefined,
    });
  });

  it("sends a JSON body and the Idempotency-Key header", async () => {
    const result = { message: { id: "m1" }, thread: { id: "t1" } };
    const mock = mockHttpClient({ status: 201, body: result }, { status: 200, body: result });
    const send = Inboxapp.messages.send({
      target: { type: "thread", threadId: "t1" },
      content: "hello",
      idempotencyKey: "order-4821-followup",
    });

    const created = await run(send, mock);
    const replayed = await run(send, mock);

    expect(mock.requests[0]).toMatchObject({
      method: "POST",
      url: `${BASE}/messages`,
      headers: {
        authorization: "Bearer ibt_test",
        "content-type": "application/json",
        "idempotency-key": "order-4821-followup",
      },
      body: { target: { type: "thread", threadId: "t1" }, content: "hello" },
    });
    expect(created).toEqual({ ...result, httpStatus: 201 });
    expect(replayed.httpStatus).toBe(200);
  });

  it("returns undefined for 204", async () => {
    const mock = mockHttpClient({ status: 204 });

    const result = await run(Inboxapp.tags.delete({ tagRef: "hot lead" }), mock);

    expect(result).toBeUndefined();
    expect(mock.requests[0]).toMatchObject({ method: "DELETE", url: `${BASE}/tags/hot%20lead` });
  });
});

describe("errors", () => {
  it("fails with the tagged error of the code", async () => {
    const mock = mockHttpClient({ status: 404, body: errorBody("threadNotFound") });

    const error = await run(Effect.flip(Inboxapp.threads.get({ threadId: "missing" })), mock);

    expect(error).toBeInstanceOf(Inboxapp.ThreadNotFound);
    expect(error).toMatchObject({
      _tag: "ThreadNotFound",
      code: "threadNotFound",
      message: "threadNotFound happened",
      details: null,
      requestId: "req_test",
    });
  });

  it("is caught by tag with typed details", async () => {
    const mock = mockHttpClient({
      status: 422,
      body: errorBody("capabilityNotSupported", { capability: "message:edit" }),
    });

    const capability = await run(
      Inboxapp.messages.edit({ messageId: "m1", content: "fixed" }).pipe(
        Effect.as("edited"),
        Effect.catchTag("CapabilityNotSupported", (error) =>
          Effect.succeed(error.details.capability),
        ),
      ),
      mock,
    );

    expect(capability).toBe("message:edit");
  });

  it("is caught by category", async () => {
    const mock = mockHttpClient({ status: 404, body: errorBody("tagNotFound") });

    const result = await run(
      Inboxapp.tags
        .get({ tagRef: "gone" })
        .pipe(
          Inboxapp.Category.catchCategory(Inboxapp.Category.NotFoundError, () =>
            Effect.succeed(null),
          ),
        ),
      mock,
    );

    expect(result).toBeNull();
  });

  it("fails with UnknownInboxappError for a code it does not know", async () => {
    const mock = mockHttpClient({ status: 418, body: errorBody("teapotRequired", { cups: 2 }) });

    const error = await run(Effect.flip(Inboxapp.team.get()), mock);

    expect(error).toMatchObject({
      _tag: "UnknownInboxappError",
      status: 418,
      code: "teapotRequired",
      requestId: "req_test",
    });
  });
});

describe("pagination", () => {
  it("streams items across pages", async () => {
    const mock = mockHttpClient(
      { body: { data: [{ id: "t1" }, { id: "t2" }], nextCursor: "c1" } },
      { body: { data: [{ id: "t3" }], nextCursor: null } },
    );

    const threads = await run(
      Stream.runCollect(Inboxapp.threads.list.items({ folder: "all", limit: 2 })),
      mock,
    );

    expect(Array.from(threads, (thread) => thread.id)).toEqual(["t1", "t2", "t3"]);
    expect(mock.requests.map((request) => request.url)).toEqual([
      `${BASE}/threads?folder=all&limit=2`,
      `${BASE}/threads?folder=all&limit=2&cursor=c1`,
    ]);
  });

  it("replays events from lastSeq while hasMore is true", async () => {
    const mock = mockHttpClient(
      { body: { data: [{ id: "e1" }], lastSeq: 14, hasMore: true } },
      { body: { data: [{ id: "e2" }], lastSeq: 15, hasMore: false } },
    );

    const pages = await run(Stream.runCollect(Inboxapp.events.list.pages({ afterSeq: 10 })), mock);

    expect(Array.from(pages, (page) => page.lastSeq)).toEqual([14, 15]);
    expect(mock.requests.map((request) => request.url)).toEqual([
      `${BASE}/events?afterSeq=10`,
      `${BASE}/events?afterSeq=14`,
    ]);
  });
});

describe("response validation", () => {
  const malformed = { body: { id: 42 } };

  it("returns the body as read by default", async () => {
    await expect(
      run(Inboxapp.tags.get({ tagRef: "vip" }), mockHttpClient(malformed)),
    ).resolves.toEqual({
      id: 42,
    });
  });

  it("fails with InboxappParseError in strict mode", async () => {
    const error = await run(
      Effect.flip(Inboxapp.tags.get({ tagRef: "vip" })).pipe(
        Effect.provide(Inboxapp.ResponseValidation.strict),
      ),
      mockHttpClient(malformed),
    );

    expect(error).toBeInstanceOf(Inboxapp.InboxappParseError);
  });

  it("accepts platforms, tags and enum values it does not know in strict mode", async () => {
    const profile = {
      id: "p1",
      platform: "somethingNew",
      platformData: { _tag: "somethingNew", extra: true },
    };
    const mock = mockHttpClient({ body: profile });

    const decoded = await Effect.runPromise(
      Inboxapp.Schemas.ProfilePlatformData.pipe(
        (schema) => Inboxapp.ResponseValidation.validate(schema, profile.platformData, String),
        Effect.provide(Inboxapp.ResponseValidation.strict),
      ),
    );

    expect(decoded).toEqual(profile.platformData);
    expect(mock.requests).toHaveLength(0);
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

  it("waits for Retry-After and tries again when rate limited", async () => {
    const mock = mockHttpClient(rateLimited, { body: { id: "team" } });

    await expect(run(Inboxapp.team.get(), mock)).resolves.toEqual({ id: "team" });
    expect(mock.requests).toHaveLength(2);
  });

  it("does not retry under Retry.none", async () => {
    const mock = mockHttpClient(rateLimited);

    const error = await run(Effect.flip(Inboxapp.team.get()).pipe(Inboxapp.Retry.none), mock);

    expect(error).toBeInstanceOf(Inboxapp.RateLimited);
    expect(Duration.toMillis((error as Inboxapp.RateLimited).retryAfter!)).toBe(0);
    expect(mock.requests).toHaveLength(1);
  });

  describe("the default policy", () => {
    const policy = Inboxapp.Retry.makeDefault();
    const post = { method: "POST", headers: {} } as const;
    const keyed = { method: "POST", headers: { "idempotency-key": "k" } } as const;
    const fields = { message: "", requestId: "", details: null as never };
    const internal = new Inboxapp.Internal({ code: "internal", ...fields });
    const unconfirmed = new Inboxapp.SendUnconfirmed({ code: "sendUnconfirmed", ...fields });
    const inProgress = new Inboxapp.SendInProgress({ code: "sendInProgress", ...fields });

    it("repeats a server error only when the request is safe to repeat", () => {
      expect(policy({ error: internal, attempt: 0, request: post })).toBeUndefined();
      expect(policy({ error: internal, attempt: 0, request: keyed })).toBeDefined();
      expect(
        policy({ error: internal, attempt: 0, request: { method: "GET", headers: {} } }),
      ).toBeDefined();
    });

    it("never repeats sendUnconfirmed, and repeats sendInProgress", () => {
      expect(policy({ error: unconfirmed, attempt: 0, request: keyed })).toBeUndefined();
      expect(policy({ error: inProgress, attempt: 0, request: keyed })).toBeDefined();
    });

    it("stops after two retries, or when the hint is longer than a minute", () => {
      expect(policy({ error: internal, attempt: 2, request: keyed })).toBeUndefined();
      const slow = Object.assign(
        new Inboxapp.PlatformRateLimited({ code: "platformRateLimited", ...fields }),
        { retryAfter: Duration.seconds(900) },
      );
      expect(policy({ error: slow, attempt: 0, request: post })).toBeUndefined();
    });
  });
});
