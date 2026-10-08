import type { ErrorsByCode } from "./services/errors.ts";

/** Every error this SDK throws extends this class. */
export class InboxappError extends Error {
  override name = "InboxappError";
}

export interface ApiErrorInit {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details: unknown;
  readonly requestId: string | null;
  readonly headers: Headers;
}

/**
 * The API answered with its error body: `{ code, message, details, requestId }`.
 * Codes the SDK knows have their own subclass; a code added to the API later arrives as a plain `ApiError`.
 */
export class ApiError<Code extends string = string, Details = unknown> extends InboxappError {
  override name = "ApiError";
  readonly status: number;
  readonly code: Code;
  readonly details: Details;
  readonly requestId: string | null;
  readonly headers: Headers;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.status = init.status;
    this.code = init.code as Code;
    this.details = init.details as Details;
    this.requestId = init.requestId;
    this.headers = init.headers;
  }
}

/** The request never produced a response. */
export class ConnectionError extends InboxappError {
  override name = "ConnectionError";
}

export class TimeoutError extends ConnectionError {
  override name = "TimeoutError";
}

/** The response was not what the API documents: a proxy's error page, or a body that is not JSON. */
export class UnexpectedResponseError extends InboxappError {
  override name = "UnexpectedResponseError";
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Unexpected response from the Inboxapp API (HTTP ${status})`);
    this.status = status;
    this.body = body;
  }
}

export function isApiError(error: unknown): error is ApiError;
export function isApiError<Code extends keyof ErrorsByCode>(
  error: unknown,
  code: Code,
): error is InstanceType<ErrorsByCode[Code]>;
export function isApiError(error: unknown, code?: string): boolean {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

/** Narrows a `_tag`-ged union, including the open "other platform" variants. */
export function hasTag<Value extends { readonly _tag: string }, Tag extends string>(
  value: Value,
  tag: Tag,
): value is Extract<Value, { readonly _tag: Tag }> {
  return value._tag === tag;
}
