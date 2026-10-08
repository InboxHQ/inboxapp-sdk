import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import type * as Schema from "effect/Schema";
import {
  buildRequest,
  errorEnvelope,
  parseBody,
  retryAfterMillis,
  type OperationDescriptor,
  type WireRequest,
} from "../wire.ts";
import { retryability } from "./category.ts";
import { Credentials } from "./credentials.ts";
import { InboxappParseError, UnknownInboxappError } from "./errors.ts";
import { COMMON_ERRORS, type CommonError } from "./services/errors.ts";
import { getErrorMatchers } from "./traits.ts";
import { validate } from "./validation.ts";

/** The errors every operation can fail with, on top of the ones it declares. */
export type InboxappOpError =
  | CommonError
  | UnknownInboxappError
  | InboxappParseError
  | HttpClientError.HttpClientError;

export type InboxappOpContext = Credentials | HttpClient.HttpClient;

export type ErrorClass = new (fields: any) => { readonly _tag: string };

export interface Protocol {
  readonly encode: (
    operation: OperationDescriptor,
    input: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<
    { readonly request: HttpClientRequest.HttpClientRequest; readonly wire: WireRequest },
    never,
    Credentials
  >;
  readonly decode: (
    operation: OperationDescriptor,
    response: HttpClientResponse.HttpClientResponse,
    output: Schema.Top | undefined,
    errors: ReadonlyArray<ErrorClass>,
  ) => Effect.Effect<unknown, unknown>;
}

/** Bearer-authenticated JSON over `https://inboxapp.com/api/v2`, with `{ code, message, details, requestId }` errors. */
export const InboxappProtocol: Protocol = {
  encode: (operation, input) =>
    Effect.gen(function* () {
      const settings = yield* yield* Credentials;
      const wire = buildRequest(operation, input, {
        baseUrl: settings.baseUrl,
        headers: { authorization: `Bearer ${Redacted.value(settings.token)}` },
      });
      const request = HttpClientRequest.make(wire.method)(wire.url, { headers: wire.headers });
      return {
        wire,
        request:
          wire.body === undefined
            ? request
            : HttpClientRequest.bodyText(request, wire.body, "application/json"),
      };
    }),

  decode: (operation, response, output, errors) =>
    Effect.gen(function* () {
      const text = yield* response.text;
      const { json, isJson } = parseBody(text);

      if (response.status >= 400) {
        const envelope = isJson ? errorEnvelope(json) : undefined;
        const requestId = envelope?.requestId ?? response.headers["x-request-id"];
        const hint = retryAfterMillis(response.headers["retry-after"], envelope?.details);
        const retryAfter = hint === undefined ? undefined : Duration.millis(hint);

        const Known = envelope && classFor([...errors, ...COMMON_ERRORS], envelope.code);
        if (Known) {
          const known = new Known({ ...envelope, requestId: requestId ?? "" });
          return yield* Effect.fail(
            retryability(known) === undefined ? known : Object.assign(known, { retryAfter }),
          );
        }
        return yield* new UnknownInboxappError({
          status: response.status,
          code: envelope?.code,
          message: envelope?.message ?? `HTTP ${response.status}`,
          requestId,
          body: isJson ? json : text,
          retryAfter,
        });
      }

      const body: unknown = isJson ? json : text;
      const value =
        operation.responseCode && body !== null && typeof body === "object"
          ? { ...body, [operation.responseCode]: response.status }
          : body;
      if (!output) return value;
      return yield* validate(output, value, (cause) => new InboxappParseError({ body, cause }));
    }),
};

const classFor = (classes: ReadonlyArray<ErrorClass>, code: string): ErrorClass | undefined =>
  classes.find((cls) => getErrorMatchers(cls).some((matcher) => matcher.code === code));
