import { createHmac } from "node:crypto";
import {
  constructEvent,
  isEvent,
  sign,
  verifySignature,
  WebhookSignatureError,
} from "@inboxapp/sdk/webhooks";
import { describe, expect, it } from "vitest";

const secret = "ibt_wh_test";
const timestamp = 1_705_312_200;
const now = () => timestamp + 10;
const payload = JSON.stringify({
  id: "evt_1",
  seq: 42,
  type: "message.received",
  apiVersion: "2",
  createdAt: "2026-09-14T10:32:00.000Z",
  object: { type: "message", id: "m1", url: "/messages/m1" },
  data: { threadId: "t1" },
});
const header = async (body = payload, at = timestamp) =>
  `t=${at},v1=${await sign(body, secret, at)}`;

describe("webhook signatures", () => {
  it("signs like HMAC-SHA256 over `{timestamp}.{body}`", async () => {
    const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");

    expect(await sign(payload, secret, timestamp)).toBe(expected);
  });

  it("accepts a valid signature, as text or bytes", async () => {
    await expect(
      verifySignature(payload, await header(), secret, { now }),
    ).resolves.toBeUndefined();
    await expect(
      verifySignature(new TextEncoder().encode(payload), await header(), secret, { now }),
    ).resolves.toBeUndefined();
  });

  it("rejects a changed body, a wrong secret and a missing header", async () => {
    const valid = await header();

    await expect(verifySignature(`${payload} `, valid, secret, { now })).rejects.toThrow(
      WebhookSignatureError,
    );
    await expect(verifySignature(payload, valid, "other", { now })).rejects.toThrow(
      "does not match",
    );
    await expect(verifySignature(payload, null, secret, { now })).rejects.toThrow("Missing");
    await expect(verifySignature(payload, "v1=abc", secret, { now })).rejects.toThrow("Malformed");
  });

  it("rejects a timestamp outside the tolerance", async () => {
    const late = () => timestamp + 301;

    await expect(verifySignature(payload, await header(), secret, { now: late })).rejects.toThrow(
      "tolerance",
    );
    await expect(
      verifySignature(payload, await header(), secret, { now: late, tolerance: 600 }),
    ).resolves.toBeUndefined();
  });

  it("parses a verified body into a typed event", async () => {
    const event = await constructEvent(payload, await header(), secret, { now });

    expect(event.type).toBe("message.received");
    if (isEvent(event, "message.received")) {
      const threadId: string = event.data.threadId;
      expect(threadId).toBe("t1");
    }
  });
});
