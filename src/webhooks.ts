import { InboxappError } from "./errors.ts";
import type { WebhookEvent, WebhookEvents, WebhookEventType } from "./services/webhooks.ts";

export type { WebhookEvent, WebhookEvents, WebhookEventType } from "./services/webhooks.ts";
export { webhookEventTypes } from "./services/webhooks.ts";

export const SIGNATURE_HEADER = "X-Inbox-Signature";

export interface VerifyOptions {
  /** Seconds a signature stays valid around its timestamp. Defaults to 300. */
  readonly tolerance?: number;
  /** The current Unix time in seconds. Defaults to the system clock. */
  readonly now?: () => number;
}

export class WebhookSignatureError extends InboxappError {
  override name = "WebhookSignatureError";
}

/**
 * Checks the `X-Inbox-Signature` header (`t=<unix seconds>,v1=<hex>`) against the raw request body.
 * Pass the body exactly as received: a re-serialized JSON object does not verify.
 */
export async function verifySignature(
  payload: string | Uint8Array,
  header: string | null | undefined,
  secret: string,
  options: VerifyOptions = {},
): Promise<void> {
  if (!header) throw new WebhookSignatureError(`Missing ${SIGNATURE_HEADER} header`);

  const fields = header.split(",").map((field) => field.trim().split("="));
  const timestamp = fields.find(([key]) => key === "t")?.[1];
  const candidates = fields.filter(([key]) => key === "v1").map(([, value]) => value ?? "");
  if (!timestamp || !/^\d+$/.test(timestamp) || candidates.length === 0) {
    throw new WebhookSignatureError(`Malformed ${SIGNATURE_HEADER} header`);
  }

  const now = options.now?.() ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > (options.tolerance ?? 300)) {
    throw new WebhookSignatureError("The signature timestamp is outside the tolerance");
  }

  const expected = await sign(payload, secret, Number(timestamp));
  if (!candidates.some((candidate) => timingSafeEqual(candidate, expected))) {
    throw new WebhookSignatureError("The signature does not match the payload");
  }
}

/** Verifies the signature, then parses the body into a typed event. */
export async function constructEvent(
  payload: string | Uint8Array,
  header: string | null | undefined,
  secret: string,
  options?: VerifyOptions,
): Promise<WebhookEvent> {
  await verifySignature(payload, header, secret, options);
  const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
  return JSON.parse(text) as WebhookEvent;
}

export function isEvent<Type extends WebhookEventType>(
  event: { readonly type: string },
  type: Type,
): event is WebhookEvents[Type] {
  return event.type === type;
}

/** The hex HMAC-SHA256 of `"{timestamp}.{payload}"`, as Inboxapp computes it. */
export async function sign(
  payload: string | Uint8Array,
  secret: string,
  timestamp: number,
): Promise<string> {
  const encoder = new TextEncoder();
  const body = typeof payload === "string" ? encoder.encode(payload) : payload;
  const prefix = encoder.encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}
