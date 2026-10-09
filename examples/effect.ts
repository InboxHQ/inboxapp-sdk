import * as Inboxapp from "@inboxapp/sdk/effect";
import { Effect, Layer } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

const program = Effect.gen(function* () {
  const page = yield* Inboxapp.threads.list({
    folder: "all",
    expand: ["profile"],
    q: "Kevin Picchi",
    limit: 1,
  });

  const thread = page.data[0];
  if (!thread) {
    return "Thread not found!";
  }

  const sent = yield* Inboxapp.messages.send({
    target: { type: "thread", threadId: thread.id },
    content: "Sending from the SDK!",
    idempotencyKey: "sdk-test-1",
  });

  const name = thread.profile?.displayName || "unknown";
  return `${sent.message.id} ${sent.httpStatus === 200 ? "already sent to " : "sent to "}${name}`;
}).pipe(
  Effect.catchTags({
    RateLimited: (error) => Effect.succeed(`Rate limited until ${error.details.resetAt}`),
    CapabilityNotSupported: (error) =>
      Effect.succeed(`This account can't ${error.details.capability}`),
  }),
);

const Live = Layer.mergeAll(FetchHttpClient.layer, Inboxapp.CredentialsFromEnv);

program.pipe(Effect.provide(Live), Effect.runPromise).then(console.log);
