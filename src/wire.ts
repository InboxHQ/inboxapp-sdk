export const DEFAULT_BASE_URL = "https://inboxapp.com/api/v2";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type QueryStyle = "form" | "deepObject";

export interface QueryBinding {
  readonly name: string;
  readonly style: QueryStyle;
}

export interface Pagination {
  readonly mode: "cursor" | "sequence";
  readonly inputToken: string;
  readonly outputToken: string;
  readonly items: string;
  readonly pageSize?: string;
  readonly hasNextPage?: string;
}

/** How one operation maps onto HTTP. Input members not bound below form the JSON body. */
export interface OperationDescriptor {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly labels?: ReadonlyArray<string>;
  readonly query?: Readonly<Record<string, QueryBinding>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly hasBody?: boolean;
  readonly responseCode?: string;
  readonly pagination?: Pagination;
}

export interface WireRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export interface ErrorEnvelope {
  readonly code: string;
  readonly message: string;
  readonly details: unknown;
  readonly requestId: string | null;
}

export function buildRequest(
  operation: OperationDescriptor,
  input: Readonly<Record<string, unknown>>,
  options: { readonly baseUrl: string; readonly headers?: Readonly<Record<string, string>> },
): WireRequest {
  const bound = new Set<string>();
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };

  let path = operation.path;
  for (const label of operation.labels ?? []) {
    bound.add(label);
    const value = input[label];
    if (value === undefined || value === null || value === "") {
      throw new TypeError(`${operation.id}: "${label}" is required`);
    }
    path = path.replace(`{${label}}`, () => encodeURIComponent(String(value)));
  }

  const pairs: Array<[string, string]> = [];
  for (const [member, binding] of Object.entries(operation.query ?? {})) {
    bound.add(member);
    if (binding.style === "deepObject") appendDeep(pairs, binding.name, input[member]);
    else appendForm(pairs, binding.name, input[member]);
  }

  for (const [member, header] of Object.entries(operation.headers ?? {})) {
    bound.add(member);
    const value = input[member];
    if (value !== undefined && value !== null) headers[header.toLowerCase()] = String(value);
  }

  let body: string | undefined;
  if (operation.hasBody) {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!bound.has(key) && value !== undefined) fields[key] = value;
    }
    body = JSON.stringify(fields);
    headers["content-type"] = "application/json";
  }

  const query = pairs.map(([key, value]) => `${encodeKey(key)}=${encodeURIComponent(value)}`);
  const url =
    options.baseUrl.replace(/\/+$/, "") + path + (query.length > 0 ? `?${query.join("&")}` : "");
  return { method: operation.method, url, headers, ...(body === undefined ? {} : { body }) };
}

/** Arrays repeat the key: `tag=a&tag=b`. */
function appendForm(pairs: Array<[string, string]>, name: string, value: unknown) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendForm(pairs, name, item);
    return;
  }
  pairs.push([name, String(value)]);
}

/** Objects and arrays nest in brackets: `sort[field]=followers`, `query[filters][0][type]=and`. */
function appendDeep(pairs: Array<[string, string]>, path: string, value: unknown) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendDeep(pairs, `${path}[${index}]`, item));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) appendDeep(pairs, `${path}[${key}]`, item);
    return;
  }
  pairs.push([path, String(value)]);
}

const encodeKey = (key: string) =>
  encodeURIComponent(key).replace(/%5B/g, "[").replace(/%5D/g, "]");

export function parseBody(text: string): { readonly json: unknown; readonly isJson: boolean } {
  if (text.trim().length === 0) return { json: undefined, isJson: true };
  try {
    return { json: JSON.parse(text), isJson: true };
  } catch {
    return { json: undefined, isJson: false };
  }
}

export function errorEnvelope(body: unknown): ErrorEnvelope | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const { code, message, details, requestId } = body as Record<string, unknown>;
  if (typeof code !== "string") return undefined;
  return {
    code,
    message: typeof message === "string" ? message : code,
    details: details ?? null,
    requestId: typeof requestId === "string" ? requestId : null,
  };
}

export type Retryability = "transient" | "throttling";

/**
 * A call that may already have been processed is only repeated when repeating it is harmless:
 * the method is idempotent, or the request carries an `Idempotency-Key`.
 * A throttled call was never processed, so it is always safe.
 */
export function canRetry(
  request: Pick<WireRequest, "method" | "headers">,
  failure: Retryability | undefined,
): boolean {
  if (failure === undefined) return false;
  if (failure === "throttling") return true;
  return IDEMPOTENT_METHODS.has(request.method) || "idempotency-key" in request.headers;
}

const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(["GET", "PUT", "DELETE"]);

/** For failures that carry no known error code: a proxy's error page, or a code added later. */
export const retryabilityOfStatus = (status: number): Retryability | undefined =>
  status === 429 ? "throttling" : status >= 500 ? "transient" : undefined;

export const MAX_RETRY_AFTER_MILLIS = 60_000;

/** The server's wait hint: the `Retry-After` header, else `details.retryAfterSeconds`. */
export function retryAfterMillis(
  header: string | null | undefined,
  details: unknown,
): number | undefined {
  const seconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  if (header) {
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  const hinted = (details as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds;
  return typeof hinted === "number" && hinted >= 0 ? hinted * 1000 : undefined;
}

export function backoffMillis(attempt: number): number {
  const exponential = Math.min(250 * 2 ** attempt, 5_000);
  return exponential + Math.random() * 100;
}

/** The continuation token of the page after `page`, or `undefined` when `page` is the last one. */
export function nextToken(
  pagination: Pagination,
  page: unknown,
  previous: unknown,
): string | number | undefined {
  const record = (page ?? {}) as Record<string, unknown>;
  const token = record[pagination.outputToken];
  const advanced = typeof token === "string" || typeof token === "number" ? token : undefined;
  if (pagination.hasNextPage !== undefined) {
    if (record[pagination.hasNextPage] !== true) return undefined;
    return advanced === undefined || advanced === previous ? undefined : advanced;
  }
  return advanced === "" || advanced === previous ? undefined : advanced;
}
