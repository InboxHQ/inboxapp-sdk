import * as Effect from "effect/Effect";
import * as HttpClientError from "effect/http/HttpClientError";
import { retryabilityOfStatus, type Retryability } from "../wire.ts";

export const AuthError = "AuthError";
export const BadRequestError = "BadRequestError";
export const ConflictError = "ConflictError";
export const NotFoundError = "NotFoundError";
export const QuotaError = "QuotaError";
export const ServerError = "ServerError";
export const ThrottlingError = "ThrottlingError";
export const ParseError = "ParseError";

export type Category =
  | typeof AuthError
  | typeof BadRequestError
  | typeof ConflictError
  | typeof NotFoundError
  | typeof QuotaError
  | typeof ServerError
  | typeof ThrottlingError
  | typeof ParseError;

const categoriesKey = "@inboxapp/sdk/error/categories";
const retryableKey = "@inboxapp/sdk/error/retryable";

type Constructor = { new (...args: any[]): any };

/** Use with `.pipe()` on a `Schema.TaggedError` class. */
export const withCategory =
  (...categories: ReadonlyArray<Category>) =>
  <C extends Constructor>(cls: C): C => {
    const existing = Object.hasOwn(cls.prototype, categoriesKey)
      ? cls.prototype[categoriesKey]
      : {};
    cls.prototype[categoriesKey] = {
      ...existing,
      ...Object.fromEntries(categories.map((category) => [category, true])),
    };
    return cls;
  };

/** Marks an error class as worth repeating; `throttling` errors were never processed. */
export const withRetryable =
  (info: { readonly throttling?: boolean } = {}) =>
  <C extends Constructor>(cls: C): C => {
    cls.prototype[retryableKey] = info.throttling ? "throttling" : "transient";
    return cls;
  };

export const withAuthError = withCategory(AuthError);
export const withBadRequestError = withCategory(BadRequestError);
export const withConflictError = withCategory(ConflictError);
export const withNotFoundError = withCategory(NotFoundError);
export const withQuotaError = withCategory(QuotaError);
export const withServerError = withCategory(ServerError);
export const withThrottlingError = withCategory(ThrottlingError);
export const withParseError = withCategory(ParseError);

export const hasCategory = (error: unknown, category: Category): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as Record<string, any>)[categoriesKey]?.[category] === true;

/** Whether repeating the call could succeed, and whether the failed call was processed at all. */
export function retryability(error: unknown): Retryability | undefined {
  if (HttpClientError.isHttpClientError(error)) {
    return error.reason._tag === "TransportError" ? "transient" : undefined;
  }
  if (typeof error !== "object" || error === null) return undefined;
  const marked = (error as Record<string, unknown>)[retryableKey];
  if (marked === "transient" || marked === "throttling") return marked;
  const { _tag, status } = error as { _tag?: unknown; status?: unknown };
  return _tag === "UnknownInboxappError" && typeof status === "number"
    ? retryabilityOfStatus(status)
    : undefined;
}

/**
 * Handles every error of the given categories.
 *
 * ```ts
 * program.pipe(Category.catchCategory(Category.NotFoundError, () => Effect.succeed(null)))
 * ```
 */
export const catchCategory =
  <A2, E2, R2>(...args: [...ReadonlyArray<Category>, (error: any) => Effect.Effect<A2, E2, R2>]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | A2, E | E2, R | R2> => {
    const handler = args[args.length - 1] as (error: any) => Effect.Effect<A2, E2, R2>;
    const categories = args.slice(0, -1) as ReadonlyArray<Category>;
    return Effect.catchIf(
      effect,
      (error) => categories.some((category) => hasCategory(error, category)),
      handler,
    ) as Effect.Effect<A | A2, E | E2, R | R2>;
  };
