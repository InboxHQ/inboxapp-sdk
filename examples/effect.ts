import * as Inboxapp from "@inboxapp/sdk/effect";
import { Effect, Layer, Stream } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

const program = Effect.gen(function* () {
  const page = yield* Inboxapp.threads.list({ folder: "inbox", tag: ["vip", "lead"] });

  const everyId = yield* Inboxapp.threads.list.items({ folder: "all", limit: 100 }).pipe(
    Stream.map((thread) => thread.id),
    Stream.runCollect,
  );

  const sent = yield* Inboxapp.messages
    .send({
      target: { type: "thread", threadId: page.data[0]!.id },
      content: "Thanks for reaching out.",
      idempotencyKey: "order-4821-followup",
    })
    .pipe(
      Effect.map((result) => result.message.id),
      Effect.catchTags({
        CapabilityNotSupported: (error) =>
          Effect.succeed(`This account can't ${error.details.capability}`),
        ThreadNotFound: () => Effect.succeed("The thread is gone"),
      }),
    );

  return { threads: everyId.length, sent };
});

const Live = Layer.mergeAll(FetchHttpClient.layer, Inboxapp.CredentialsFromEnv);

program.pipe(Effect.provide(Live), Effect.runPromise).then(console.log);
