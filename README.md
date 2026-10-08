# @inboxapp/sdk

TypeScript SDK for the [Inboxapp API v2](https://docs.inboxapp.com/v2/developer-api), generated from its OpenAPI document.

It ships two clients, generated in the same run from the same spec:

- `@inboxapp/sdk` is the default. It returns Promises, uses `fetch`, and has no dependencies.
- `@inboxapp/sdk/effect` is for [Effect](https://effect.website) programs. Operations are Effects with typed errors.

## Install

```bash
bun add @inboxapp/sdk
```

Node 20 or later, Bun, Deno, and edge runtimes with `fetch` work. The default client has no dependencies.

## Quick start

Create an API token in Inboxapp, then:

```ts
import { Inboxapp } from "@inboxapp/sdk";

const inbox = new Inboxapp({ token: process.env.INBOX_API_TOKEN! });

const page = await inbox.threads.list({
  folder: "inbox",
  tag: ["vip", "lead"],
  expand: ["contact", "profile"],
});

const sent = await inbox.messages.send({
  target: { type: "thread", threadId: page.data[0]!.id },
  content: "Thanks for reaching out.",
});
```

Each method takes one object. Path parameters, query parameters and body fields sit side by side in it, so `inbox.contacts.update({ contactId, notes: null })` sends `PATCH /contacts/{contactId}` with `{ "notes": null }`. Arrays in the query repeat the key, as the API expects: `tag=vip&tag=lead`.

Methods follow the API's operation IDs. `threads.list` in the reference is `inbox.threads.list`.

### Options

```ts
new Inboxapp({
  token,
  baseUrl: "https://inboxapp.com/api/v2", // the default
  maxRetries: 2, // the default
  timeout: 60_000, // milliseconds per attempt, the default
  fetch: customFetch,
  headers: { "X-Trace": "abc" },
});
```

Every method takes a second argument for one call: `{ signal, headers, maxRetries, timeout }`.

## Errors

The API answers every failure with `{ code, message, details, requestId }`. The SDK throws one class per `code`, all extending `ApiError`.

```ts
import { isApiError, RateLimited } from "@inboxapp/sdk";

try {
  await inbox.messages.edit({ messageId, content: "fixed" });
} catch (error) {
  if (error instanceof RateLimited) {
    console.log(error.details.resetAt);
  } else if (isApiError(error, "capabilityNotSupported")) {
    console.log(error.details.capability); // typed for this code
  } else if (isApiError(error)) {
    console.log(error.status, error.code, error.message, error.requestId);
  } else {
    throw error;
  }
}
```

`isApiError(error, code)` and `instanceof` both narrow `details` to the shape the spec documents for that code. Each method's JSDoc names its error type, such as `ThreadsGetError`, a union of the codes that operation documents.

The API can add codes within v2. A code this SDK version does not know arrives as a plain `ApiError` with `code`, `status` and `details` set, so handle it by status.

Other failures:

| Class                     | When                                                             |
| ------------------------- | ---------------------------------------------------------------- |
| `ConnectionError`         | `fetch` failed before a response arrived                          |
| `TimeoutError`            | An attempt took longer than `timeout`. Extends `ConnectionError` |
| `UnexpectedResponseError` | The response was not the API's JSON, such as a proxy's error page |

All of them extend `InboxappError`.

## Pagination

Collections return `{ data, nextCursor }`. Call the method for one page, or iterate:

```ts
for await (const thread of inbox.threads.list.items({ folder: "all", limit: 100 })) {
  console.log(thread.id);
}

for await (const page of inbox.threads.list.pages({ folder: "all" })) {
  console.log(page.data.length);
}
```

`items` and `pages` pass each `nextCursor` back as `cursor` and keep your filters. To resume, pass a saved `cursor` in the input.

`events.list` pages by sequence number. The same helpers follow `lastSeq` while `hasMore` is true:

```ts
for await (const event of inbox.events.list.items({ afterSeq: lastSeenSeq })) {
  await handle(event);
}
```

## Sending safely

`POST /messages` takes an `Idempotency-Key`. Pass it as `idempotencyKey`:

```ts
const result = await inbox.messages.send({
  target: { type: "contact", accountLinkId, contactId },
  content: "Hello",
  idempotencyKey: "order-4821-followup",
});

result.httpStatus; // 201 for a new send, 200 for a replay of the key
```

The API returns the same body for both, so the SDK adds `httpStatus` to the result.

## Retries

The client retries up to `maxRetries` times, with backoff:

- `429` responses, always. A rate-limited request was not processed.
- `500`, `502 platformError`, `503`, `409 sendInProgress` and network failures, but only when repeating the request is harmless. That means `GET`, `PUT` and `DELETE` requests, and sends that carry an `idempotencyKey`.
- `sendUnconfirmed`, never. The platform may have delivered the message.

It waits for `Retry-After` or `details.retryAfterSeconds` when the API gives one. If that wait is longer than a minute, it throws the error instead.

A send without an `idempotencyKey` is not retried after a server error or a network failure, because it could send twice.

## Open values

The API can add platforms, enum values and fields within v2, and the types allow for it.

- `platform` is a `string`.
- Enums in responses accept other strings: `"active" | "offline" | "paused" | (string & {})`. Enums in requests are closed, so a typo fails to compile.
- `platformData` unions end with a variant for platforms this SDK version does not describe. Narrow with `hasTag`:

```ts
import { hasTag } from "@inboxapp/sdk";

if (hasTag(profile.platformData, "twitter")) {
  profile.platformData.badge;
}
```

## Webhooks

Verify the `X-Inbox-Signature` header against the raw request body, before parsing it:

```ts
import { constructEvent, isEvent } from "@inboxapp/sdk/webhooks";

const event = await constructEvent(
  await request.text(),
  request.headers.get("X-Inbox-Signature"),
  process.env.INBOX_WEBHOOK_SECRET!,
);

if (isEvent(event, "message.received")) {
  const message = await inbox.messages.get({ messageId: event.object.id });
}
```

`constructEvent` throws `WebhookSignatureError` when the signature does not match or its timestamp is more than 5 minutes off. Change that with `{ tolerance: seconds }`. `verifySignature` does the check without parsing. Both use Web Crypto.

## Effect client

The Effect client needs `effect` 4 installed alongside the SDK:

```bash
bun add @inboxapp/sdk effect
```

```ts
import * as Inboxapp from "@inboxapp/sdk/effect";
import { Effect, Layer, Stream } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

const program = Effect.gen(function* () {
  const page = yield* Inboxapp.threads.list({ folder: "inbox", tag: ["vip", "lead"] });

  const ids = yield* Inboxapp.threads.list.items({ folder: "all" }).pipe(
    Stream.map((thread) => thread.id),
    Stream.runCollect,
  );

  return yield* Inboxapp.messages
    .send({
      target: { type: "thread", threadId: page.data[0]!.id },
      content: "Thanks for reaching out.",
      idempotencyKey: "order-4821-followup",
    })
    .pipe(
      Effect.catchTag("CapabilityNotSupported", (error) =>
        Effect.succeed(`This account can't ${error.details.capability}`),
      ),
    );
});

const Live = Layer.mergeAll(FetchHttpClient.layer, Inboxapp.CredentialsFromEnv);

program.pipe(Effect.provide(Live), Effect.runPromise);
```

An operation needs two services, an `HttpClient` and `Credentials`.

- `Inboxapp.CredentialsFromEnv` reads `INBOX_API_TOKEN`, and `INBOX_API_BASE_URL` if set.
- `Inboxapp.fromToken({ token: Redacted.make("..."), baseUrl })` takes them directly.

Each error code is a `Schema.TaggedError` whose `_tag` is the code in PascalCase, so `threadNotFound` is `Inboxapp.ThreadNotFound`. An operation's error type lists the codes the spec documents for it, plus the four any operation can return. A code the SDK does not know fails with `UnknownInboxappError`. `Inboxapp.Category.catchCategory(Inboxapp.Category.NotFoundError, ...)` handles a whole family at once.

Paginated operations have `.pages(input)` and `.items(input)`, which return Streams.

Retries follow the rules above. Replace the policy with `Inboxapp.Retry.policy(...)`, or turn retries off with `Inboxapp.Retry.none`:

```ts
Inboxapp.team.get().pipe(Inboxapp.Retry.none);
```

Responses are returned as read. To decode every response against its schema and fail with `InboxappParseError` on a mismatch, provide `Inboxapp.ResponseValidation.strict`. Schemas are under `Inboxapp.Schemas`.

## How it is built

```
spec/openapi.json                the API's OpenAPI 3.1 document
  │  scripts/convert.ts          OpenAPI → Smithy 2.0 JSON, then patches/*.patch.json
  ▼
.generated-specs/inboxapp.json   the model both clients are generated from
  │  scripts/generate.ts
  ▼
src/services/                    default client: types, operations, errors, one class per service
src/effect/services/             Effect client: schemas, tagged errors, one module per service
```

Everything in those two `services` directories is generated and committed. The rest of `src/` is written by hand: the `fetch` transport, the Effect protocol, retries, and `src/wire.ts`, which builds the HTTP request for both clients.

The pipeline follows [distilled](https://github.com/alchemy-run/distilled). See `NOTICE`.

## Regenerating

Replace `spec/openapi.json` with the new document, then:

```bash
bun install
bun run generate
```

That converts the spec, applies the patches, writes both clients and formats them. Running it again with the same spec changes nothing, and `bun run generate:check` fails if the committed output is stale.

To correct something the spec gets wrong or leaves out, add an RFC 6902 patch in `patches/`. A patch edits the converted model, never the generated TypeScript, and it needs a `description` saying what the spec says and what the API does. A patch whose pointer no longer exists fails the run.

```bash
bun run type-check  # tsc -b, generated code included
bun run test        # vitest, no network and no credentials
bun run build       # emits lib/
bun check           # oxlint and oxfmt, as the pre-commit hook runs them
bun fix             # apply lint fixes and format
```

## Attribution

See `NOTICE` for third-party attribution.
