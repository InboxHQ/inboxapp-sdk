import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { nextToken, type Pagination } from "../wire.ts";

type Input = Readonly<Record<string, unknown>>;

/** Every page, following the continuation token until the last one. */
export const pages = <O, E, R>(
  call: (input: Input) => Effect.Effect<O, E, R>,
  input: Input,
  pagination: Pagination,
): Stream.Stream<O, E, R> =>
  Stream.unfold({ token: input[pagination.inputToken], done: false }, (state) =>
    Effect.gen(function* () {
      if (state.done) return undefined;
      const page = yield* call(
        state.token === undefined ? input : { ...input, [pagination.inputToken]: state.token },
      );
      const next = nextToken(pagination, page, state.token);
      return [page, { token: next, done: next === undefined }] as const;
    }),
  );

export const items = <O, Item, E, R>(
  stream: Stream.Stream<O, E, R>,
  pagination: Pagination,
): Stream.Stream<Item, E, R> =>
  Stream.flatMap(stream, (page) =>
    Stream.fromIterable(((page as Record<string, unknown>)[pagination.items] as Item[]) ?? []),
  );
