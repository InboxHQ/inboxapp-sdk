import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { backoffMillis, canRetry, MAX_RETRY_AFTER_MILLIS, type WireRequest } from "../wire.ts";
import { retryability } from "./category.ts";

export interface Failure {
  readonly error: unknown;
  /** 0 for the first failure. */
  readonly attempt: number;
  readonly request: Pick<WireRequest, "method" | "headers">;
}

/** Returns how long to wait before the next attempt, or `undefined` to fail with the error. */
export type Policy = (failure: Failure) => Duration.Duration | undefined;

/** Provide a `Policy` under this tag to replace the default for every call below it. */
export class Retry extends Context.Service<Retry, Policy>()("@inboxapp/sdk/Retry") {}

/**
 * Retries throttled calls, and transient failures of calls that are safe to repeat: idempotent
 * methods, and sends that carry an `Idempotency-Key`. Waits for the server's hint when it gives
 * one, and fails instead when the hint is longer than a minute.
 */
export const makeDefault =
  (options: { readonly maxRetries?: number } = {}): Policy =>
  ({ error, attempt, request }) => {
    if (attempt >= (options.maxRetries ?? 2)) return undefined;
    if (!canRetry(request, retryability(error))) return undefined;
    const hint = (error as { retryAfter?: unknown }).retryAfter;
    if (!Duration.isDuration(hint)) return Duration.millis(backoffMillis(attempt));
    return Duration.toMillis(hint) > MAX_RETRY_AFTER_MILLIS ? undefined : hint;
  };

export const policy =
  (value: Policy) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Retry>> =>
    Effect.provideService(effect, Retry, value);

/** Disables retries for every call below it. */
export const none = policy(() => undefined);
