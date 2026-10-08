import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type { OperationDescriptor, Pagination, WireRequest } from "../wire.ts";
import * as Paginate from "./pagination.ts";
import type { ErrorClass, Protocol } from "./protocol.ts";
import { makeDefault, type Policy } from "./retry.ts";
import { describe } from "./traits.ts";

export interface OperationConfig {
  /** The spec's `operationId`. */
  readonly id: string;
  readonly input: Schema.Top;
  /** Absent for operations that answer without a body. */
  readonly output?: Schema.Top;
  readonly errors?: ReadonlyArray<ErrorClass>;
  readonly protocol: Protocol;
  readonly retry: Context.Key<any, Policy>;
  readonly pagination?: Pagination;
}

type Call<I, O, E, R> = {} extends I
  ? (input?: I) => Effect.Effect<O, E, R>
  : (input: I) => Effect.Effect<O, E, R>;

type Streamed<I, O, E, R> = {} extends I
  ? (input?: I) => Stream.Stream<O, E, R>
  : (input: I) => Stream.Stream<O, E, R>;

/** A generated operation: call it with its input to get an Effect. */
export type OperationMethod<I, O, E, R> = Call<I, O, E, R> & {
  readonly id: string;
  readonly input: Schema.Top;
  readonly output: Schema.Top | undefined;
  readonly errors: ReadonlyArray<ErrorClass>;
};

export type PaginatedOperationMethod<I, O, E, R, Item> = OperationMethod<I, O, E, R> & {
  readonly pagination: Pagination;
  /** Every page, following the continuation token until the last one. */
  readonly pages: Streamed<I, O, E, R>;
  /** Every item of every page. */
  readonly items: Streamed<I, Item, E, R>;
};

type Input = Readonly<Record<string, unknown>>;

/** The config thunk runs on the first call, so importing a service module builds no schema. */
export function make<I, O, E, R>(configFn: () => OperationConfig): OperationMethod<I, O, E, R> {
  let prepared: { config: OperationConfig; descriptor: OperationDescriptor } | undefined;
  const prepare = () => {
    if (prepared) return prepared;
    const config = configFn();
    const descriptor = describe(config.id, config.input.ast, config.output?.ast, config.pagination);
    return (prepared = { config, descriptor });
  };

  const call = (input: Input = {}) =>
    Effect.suspend(() => {
      const { config, descriptor } = prepare();
      let sent: WireRequest | undefined;
      const attempt = Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const { request, wire } = yield* config.protocol.encode(descriptor, input);
        sent = wire;
        const response = yield* client.execute(request);
        return yield* config.protocol.decode(
          descriptor,
          response,
          config.output,
          config.errors ?? [],
        );
      });
      return Effect.flatMap(Effect.serviceOption(config.retry), (provided) =>
        retrying(attempt, Option.getOrElse(provided, makeDefault), () => sent),
      );
    });

  Object.defineProperties(call, {
    id: { get: () => prepare().config.id },
    input: { get: () => prepare().config.input },
    output: { get: () => prepare().config.output },
    errors: { get: () => prepare().config.errors ?? [] },
    pagination: { get: () => prepare().config.pagination },
  });
  return call as unknown as OperationMethod<I, O, E, R>;
}

export function makePaginated<I, O, E, R, Item>(
  configFn: () => OperationConfig & { readonly pagination: Pagination },
): PaginatedOperationMethod<I, O, E, R, Item> {
  const call = make(configFn) as unknown as (input: Input) => Effect.Effect<O, E, R>;
  let pagination: Pagination | undefined;
  const trait = () => (pagination ??= configFn().pagination);

  const pages = (input: Input = {}) => Paginate.pages(call, input, trait());
  const items = (input: Input = {}) => Paginate.items(pages(input), trait());
  return Object.assign(call, { pages, items }) as unknown as PaginatedOperationMethod<
    I,
    O,
    E,
    R,
    Item
  >;
}

function retrying<A, E, R>(
  attempt: Effect.Effect<A, E, R>,
  policy: Policy,
  sent: () => WireRequest | undefined,
  failures = 0,
): Effect.Effect<A, E, R> {
  return Effect.catch(attempt, (error) => {
    const request = sent();
    const wait = request && policy({ error, attempt: failures, request });
    return wait === undefined
      ? Effect.fail(error)
      : Effect.andThen(Effect.sleep(wait), retrying(attempt, policy, sent, failures + 1));
  });
}
