import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Inboxapp } from "@inboxapp/sdk";
import * as Effectful from "@inboxapp/sdk/effect";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { Trait, type Member, type Model } from "../scripts/codegen/model.ts";
import { MODEL_PATH } from "../scripts/codegen/pipeline.ts";
import { analyze } from "../scripts/codegen/sdk.ts";

interface Sent {
  method: string;
  url: string;
  body: string | undefined;
  idempotencyKey: string | undefined;
  contentType: string | undefined;
  authorization: string | undefined;
}

const model: Model = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "..", MODEL_PATH), "utf8"),
);
const sdk = analyze(model);

/** A value for every member, awkward enough to exercise encoding. */
function sample(member: Member, depth = 0): unknown {
  switch (member.target) {
    case "smithy.api#String":
      return "a b/c?d&e=é";
    case "smithy.api#Integer":
    case "smithy.api#Double":
      return 7;
    case "smithy.api#Boolean":
      return true;
    case "smithy.api#Document":
      return { any: ["thing"] };
    case "smithy.api#Unit":
      return null;
  }
  const shape = model.shapes[member.target]!;
  switch (shape.type) {
    case "structure":
      if (depth > 6) return {};
      return Object.fromEntries(
        Object.entries(shape.members).map(([key, value]) => [key, sample(value, depth + 1)]),
      );
    case "union":
      return sample(Object.values(shape.members)[0]!, depth + 1);
    case "enum":
      return Object.values(shape.members)[0]!.traits![Trait.enumValue];
    case "list":
      return [sample(shape.member, depth + 1), sample(shape.member, depth + 1)];
    case "map":
      return { key: sample(shape.value, depth + 1) };
    case "boolean":
      return shape.traits?.[Trait.constant] ?? true;
    case "string":
      return "id 1";
    default:
      return 7;
  }
}

const at = (root: unknown, path: string[]) =>
  path.reduce((value, key) => (value as Record<string, unknown>)[key], root);

async function sentByDefaultClient(path: string[], input: unknown): Promise<Sent> {
  let sent: Sent | undefined;
  const inbox = new Inboxapp({
    token: "ibt_test",
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      sent = {
        method: init?.method ?? "GET",
        url: new URL(String(url)).href,
        body: typeof init?.body === "string" ? init.body : undefined,
        idempotencyKey: headers.get("idempotency-key") ?? undefined,
        contentType: headers.get("content-type") ?? undefined,
        authorization: headers.get("authorization") ?? undefined,
      };
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  });
  await (at(inbox, path) as (input: unknown) => Promise<unknown>)(input);
  return sent!;
}

async function sentByEffectClient(path: string[], input: unknown): Promise<Sent> {
  let sent: Sent | undefined;
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const body = request.body;
      sent = {
        method: request.method,
        url: url.href,
        body: body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : undefined,
        idempotencyKey: request.headers["idempotency-key"],
        contentType: body._tag === "Uint8Array" ? body.contentType : undefined,
        authorization: request.headers.authorization,
      };
      return HttpClientResponse.fromWeb(request, new Response("{}"));
    }),
  );
  const call = at(Effectful, path) as (
    input: unknown,
  ) => Effect.Effect<unknown, unknown, Effectful.InboxappOpContext>;
  await Effect.runPromise(
    call(input).pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(HttpClient.HttpClient, client),
          Effectful.fromToken({ token: Redacted.make("ibt_test") }),
        ),
      ),
    ),
  );
  return sent!;
}

describe("both clients send the same request", () => {
  for (const service of sdk.services) {
    for (const operation of service.operations) {
      it(operation.operationId, async () => {
        const path = [service.namespace, operation.method];
        const input = sample({ target: operation.input });

        const fromDefault = await sentByDefaultClient(path, input);
        const fromEffect = await sentByEffectClient(path, input);

        expect(fromEffect).toEqual(fromDefault);
        expect(fromDefault.method).toBe(operation.http.method);
        expect(fromDefault.authorization).toBe("Bearer ibt_test");
      });
    }
  }

  it("covers every operation of the spec", () => {
    expect(sdk.operations).toHaveLength(37);
  });
});
