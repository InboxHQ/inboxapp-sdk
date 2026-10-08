// Checked by `tsc -b`; nothing here runs.
import type {
  ApiError,
  Inboxapp,
  MessagesSendError,
  Platform,
  ProfilePlatformData,
  RateLimited,
  SendUnconfirmed,
  Thread,
  ThreadPage,
  ThreadsListRequest,
} from "@inboxapp/sdk";
import { hasTag, isApiError } from "@inboxapp/sdk";
import type * as Effectful from "@inboxapp/sdk/effect";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import { expectTypeOf } from "vitest";

export function defaultClient(inbox: Inboxapp, caught: unknown, platformData: ProfilePlatformData) {
  expectTypeOf(inbox.threads.list).parameter(0).toEqualTypeOf<ThreadsListRequest | undefined>();
  expectTypeOf(inbox.threads.list).returns.toEqualTypeOf<Promise<ThreadPage>>();
  expectTypeOf(inbox.threads.list.items).returns.toEqualTypeOf<AsyncIterableIterator<Thread>>();
  expectTypeOf(inbox.contacts.addTag).returns.toEqualTypeOf<Promise<void>>();
  expectTypeOf(inbox.messages.send).returns.resolves.toHaveProperty("httpStatus");

  void inbox.platforms.list();
  // @ts-expect-error threadId is required
  void inbox.threads.get();
  // @ts-expect-error "spam" is not a folder
  void inbox.threads.list({ folder: "spam" });

  expectTypeOf<Platform>().toEqualTypeOf<string>();
  const state: Thread["acceptanceState"] = "aStateAddedLater";
  void state;

  if (hasTag(platformData, "twitter")) {
    expectTypeOf(platformData.profileType).toEqualTypeOf<
      "personal" | "business" | "government" | (string & {})
    >();
  }

  if (isApiError(caught)) expectTypeOf(caught).toEqualTypeOf<ApiError>();
  if (isApiError(caught, "rateLimited")) {
    expectTypeOf(caught).toEqualTypeOf<RateLimited>();
    expectTypeOf(caught.details.resetAt).toEqualTypeOf<string>();
  }
  expectTypeOf<SendUnconfirmed>().toExtend<MessagesSendError>();
  expectTypeOf<SendUnconfirmed["code"]>().toEqualTypeOf<"sendUnconfirmed">();
}

export function effectClient() {
  type Get = ReturnType<typeof Effectful.threads.get>;
  type Items = ReturnType<typeof Effectful.threads.list.items>;

  expectTypeOf<Effect.Success<Get>>().toEqualTypeOf<Thread>();
  expectTypeOf<Effect.Error<Get>>().toEqualTypeOf<Effectful.threads.GetError>();
  expectTypeOf<Effectful.ThreadNotFound>().toExtend<Effect.Error<Get>>();
  expectTypeOf<Effect.Services<Get>>().toEqualTypeOf<Effectful.InboxappOpContext>();
  expectTypeOf<Items>().toExtend<
    Stream.Stream<Thread, Effectful.threads.ListError, Effectful.InboxappOpContext>
  >();
  expectTypeOf<Effectful.RateLimited["details"]["limit"]>().toEqualTypeOf<number>();
}
