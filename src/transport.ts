import { ApiError, ConnectionError, TimeoutError, UnexpectedResponseError } from "./errors.ts";
import { errorsByCode, retryableCodes } from "./services/errors.ts";
import {
  backoffMillis,
  buildRequest,
  canRetry,
  DEFAULT_BASE_URL,
  errorEnvelope,
  MAX_RETRY_AFTER_MILLIS,
  nextToken,
  parseBody,
  retryAfterMillis,
  retryabilityOfStatus,
  type OperationDescriptor,
  type Retryability,
  type WireRequest,
} from "./wire.ts";

export interface ClientOptions {
  /** An Inboxapp API token, sent as `Authorization: Bearer <token>`. */
  readonly token: string;
  /** Defaults to `https://inboxapp.com/api/v2`. */
  readonly baseUrl?: string;
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Retries after the first attempt. Defaults to 2. */
  readonly maxRetries?: number;
  /** Milliseconds allowed per attempt. Defaults to 60 000. */
  readonly timeout?: number;
  /** Sent with every request. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxRetries?: number;
  readonly timeout?: number;
}

export type Method<Input, Output> = {} extends Input
  ? (input?: Input, options?: RequestOptions) => Promise<Output>
  : (input: Input, options?: RequestOptions) => Promise<Output>;

export type PaginatedMethod<Input, Output, Item> = Method<Input, Output> & {
  /** Every page, following the continuation token until the last one. */
  readonly pages: {} extends Input
    ? (input?: Input, options?: RequestOptions) => AsyncIterableIterator<Output>
    : (input: Input, options?: RequestOptions) => AsyncIterableIterator<Output>;
  /** Every item of every page. */
  readonly items: {} extends Input
    ? (input?: Input, options?: RequestOptions) => AsyncIterableIterator<Item>
    : (input: Input, options?: RequestOptions) => AsyncIterableIterator<Item>;
};

type Input = Readonly<Record<string, unknown>>;

export class Transport {
  readonly #options: ClientOptions;

  constructor(options: ClientOptions) {
    if (!options?.token) throw new TypeError("Inboxapp: `token` is required");
    this.#options = options;
  }

  method<I, O>(operation: OperationDescriptor): Method<I, O> {
    const call = (input?: Input, options?: RequestOptions) => this.call(operation, input, options);
    return call as Method<I, O>;
  }

  paginated<I, O, Item>(operation: OperationDescriptor): PaginatedMethod<I, O, Item> {
    const pagination = operation.pagination;
    if (!pagination) throw new TypeError(`${operation.id} is not paginated`);

    const call = (input?: Input, options?: RequestOptions) => this.call(operation, input, options);
    const pages = async function* (input: Input = {}, options?: RequestOptions) {
      let token = input[pagination.inputToken];
      while (true) {
        const page = await call(
          token === undefined ? input : { ...input, [pagination.inputToken]: token },
          options,
        );
        yield page;
        const next = nextToken(pagination, page, token);
        if (next === undefined) return;
        token = next;
      }
    };
    const items = async function* (input?: Input, options?: RequestOptions) {
      for await (const page of pages(input, options)) {
        yield* ((page as Record<string, unknown>)[pagination.items] as unknown[]) ?? [];
      }
    };
    return Object.assign(call, { pages, items }) as unknown as PaginatedMethod<I, O, Item>;
  }

  async call(
    operation: OperationDescriptor,
    input: Input = {},
    options: RequestOptions = {},
  ): Promise<unknown> {
    const request = buildRequest(operation, input, {
      baseUrl: this.#options.baseUrl ?? DEFAULT_BASE_URL,
      headers: {
        ...lowercased(this.#options.headers),
        ...lowercased(options.headers),
        authorization: `Bearer ${this.#options.token}`,
      },
    });
    const maxRetries = options.maxRetries ?? this.#options.maxRetries ?? 2;

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#attempt(operation, request, options);
      } catch (error) {
        const hint =
          error instanceof ApiError
            ? retryAfterMillis(error.headers.get("retry-after"), error.details)
            : undefined;
        const giveUp =
          attempt >= maxRetries ||
          !canRetry(request, retryability(error)) ||
          (hint !== undefined && hint > MAX_RETRY_AFTER_MILLIS);
        if (giveUp) throw error;
        await sleep(hint ?? backoffMillis(attempt), options.signal);
      }
    }
  }

  async #attempt(
    operation: OperationDescriptor,
    request: WireRequest,
    options: RequestOptions,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(options.timeout ?? this.#options.timeout ?? 60_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const send = this.#options.fetch ?? globalThis.fetch;

    let response: Response;
    let text: string;
    try {
      response = await send(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal,
      });
      text = await response.text();
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      if (timeout.aborted) throw new TimeoutError(`${operation.id} timed out`, { cause });
      throw new ConnectionError(`${operation.id} could not reach the Inboxapp API`, { cause });
    }

    const { json, isJson } = parseBody(text);
    if (!response.ok) {
      const envelope = isJson ? errorEnvelope(json) : undefined;
      if (!envelope) throw new UnexpectedResponseError(response.status, text);
      const Known = (errorsByCode as Record<string, typeof ApiError | undefined>)[envelope.code];
      throw new (Known ?? ApiError)({
        ...envelope,
        status: response.status,
        requestId: envelope.requestId ?? response.headers.get("x-request-id"),
        headers: response.headers,
      });
    }
    if (!isJson) throw new UnexpectedResponseError(response.status, text);
    if (operation.responseCode && json !== null && typeof json === "object") {
      return { ...json, [operation.responseCode]: response.status };
    }
    return json;
  }
}

function retryability(error: unknown): Retryability | undefined {
  if (error instanceof ConnectionError) return "transient";
  if (error instanceof ApiError) {
    return (
      (retryableCodes as Record<string, Retryability | undefined>)[error.code] ??
      (error.constructor === ApiError ? retryabilityOfStatus(error.status) : undefined)
    );
  }
  if (error instanceof UnexpectedResponseError) return retryabilityOfStatus(error.status);
  return undefined;
}

const lowercased = (headers: Readonly<Record<string, string>> = {}) =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));

function sleep(millis: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, millis);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
