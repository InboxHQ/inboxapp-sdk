import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { finalize } from "./finalize.ts";
import { Prelude, Trait, type Model, type OperationShape, type StructureShape } from "./model.ts";
import { convertOpenApi } from "./openapi.ts";
import { buildModel, MODEL_PATH, serialize } from "./pipeline.ts";

const error = (code: string) => ({
  type: "object",
  properties: {
    code: { type: "string", enum: [code] },
    message: { type: "string" },
    details: { type: "null" },
    requestId: { type: "string" },
  },
  required: ["code", "message", "details", "requestId"],
  additionalProperties: false,
});

const json = (schema: unknown) => ({ content: { "application/json": { schema } } });

const document = {
  openapi: "3.1.0",
  info: { title: "Test", version: "1" },
  tags: [{ name: "Widgets", description: "Widgets." }],
  paths: {
    "/widgets": {
      get: {
        operationId: "widgets.list",
        tags: ["Widgets"],
        summary: "List widgets",
        parameters: [
          { name: "kind", in: "query", schema: { type: "array", items: { type: "string" } } },
          { name: "cursor", in: "query", schema: { type: "string" } },
          {
            name: "sort",
            in: "query",
            style: "deepObject",
            explode: true,
            schema: { type: "object", properties: { field: { type: "string", enum: ["a", "b"] } } },
          },
          { name: "idempotency-key", in: "header", schema: { type: "string" } },
        ],
        responses: {
          200: json({ $ref: "#/components/schemas/WidgetPage" }),
          400: json({ $ref: "#/components/schemas/Invalid" }),
          404: json({
            anyOf: [
              { $ref: "#/components/schemas/WidgetNotFoundEncoded" },
              { $ref: "#/components/schemas/ListNotFound" },
            ],
          }),
        },
      },
    },
    "/widgets/{widgetId}": {
      get: {
        operationId: "widgets.get",
        tags: ["Widgets"],
        parameters: [{ name: "widgetId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: json({ $ref: "#/components/schemas/Widget" }),
          400: json({ $ref: "#/components/schemas/Invalid" }),
        },
      },
    },
  },
  components: {
    schemas: {
      Invalid: error("invalid"),
      WidgetNotFoundEncoded: error("widgetNotFound"),
      ListNotFound: error("listNotFound"),
      WidgetPage: {
        type: "object",
        properties: {
          data: { type: "array", items: { $ref: "#/components/schemas/Widget" } },
          nextCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
        required: ["data", "nextCursor"],
        additionalProperties: false,
      },
      Widget: {
        type: "object",
        properties: {
          size: {
            anyOf: [
              {
                anyOf: [
                  { type: "number" },
                  { type: "string", enum: ["Infinity", "-Infinity", "NaN"] },
                ],
              },
              { type: "null" },
            ],
          },
          state: { type: "string", enum: ["on", "off"] },
          kind: { type: "string", enum: ["widget"] },
          data: {
            anyOf: [
              {
                type: "object",
                properties: { _tag: { type: "string", enum: ["twitter"] } },
                required: ["_tag"],
                additionalProperties: false,
              },
              { type: "object", properties: { _tag: { type: "string" } }, required: ["_tag"] },
            ],
          },
        },
        required: ["size", "state", "kind", "data"],
        additionalProperties: false,
      },
    },
  },
};

const convert = () => finalize(convertOpenApi(document, { retryableStatuses: {} }));
const shape = <S>(model: Model, name: string) => model.shapes[`com.inboxapp.api#${name}`] as S;

describe("convertOpenApi", () => {
  const model = convert();
  const operation = shape<OperationShape>(model, "WidgetsList");
  const request = shape<StructureShape>(model, "WidgetsListRequest");
  const widget = shape<StructureShape>(model, "Widget");

  it("groups operations into services named by their operationId", () => {
    const service = shape<{ traits: Record<string, unknown> }>(model, "WidgetsService");

    expect(service.traits[Trait.namespace]).toBe("widgets");
    expect(operation.traits[Trait.operationName]).toBe("list");
  });

  it("binds parameters, keeping the query style", () => {
    expect(request.members.kind!.traits).toEqual({ [Trait.httpQuery]: "kind" });
    expect(request.members.sort!.traits).toEqual({
      [Trait.httpQuery]: "sort",
      [Trait.queryStyle]: "deepObject",
    });
    expect(request.members.idempotencyKey!.traits).toEqual({
      [Trait.httpHeader]: "Idempotency-Key",
    });
    expect(shape<StructureShape>(model, "WidgetsGetRequest").members.widgetId!.traits).toEqual({
      [Trait.httpLabel]: {},
      [Trait.required]: {},
    });
  });

  it("detects cursor pagination", () => {
    expect(operation.traits[Trait.paginated]).toEqual({
      mode: "cursor",
      inputToken: "cursor",
      outputToken: "nextCursor",
      items: "data",
    });
  });

  it("names errors by their code and hoists the ones every operation shares", () => {
    const service = shape<{ errors: unknown }>(model, "WidgetsService");
    const notFound = shape<StructureShape>(model, "WidgetNotFound");

    expect(service.errors).toEqual([{ target: "com.inboxapp.api#Invalid" }]);
    expect(operation.errors).toEqual([
      { target: "com.inboxapp.api#WidgetNotFound" },
      { target: "com.inboxapp.api#ListNotFound" },
    ]);
    expect(notFound.traits).toMatchObject({
      [Trait.httpError]: 404,
      [Trait.error]: "client",
      [Trait.errorMatchers]: [{ code: "widgetNotFound" }],
    });
  });

  it("rejects an error returned with two statuses", () => {
    expect(() => convert()).not.toThrow();
    const twice = structuredClone(document);
    (twice.paths["/widgets"].get.responses as Record<number, unknown>)[409] = json({
      $ref: "#/components/schemas/WidgetNotFoundEncoded",
    });

    expect(() => convertOpenApi(twice, { retryableStatuses: {} })).toThrow("several statuses");
  });

  it("reads a number with non-finite sentinels as a nullable number", () => {
    expect(widget.members.size).toEqual({
      target: Prelude.Double,
      traits: { [Trait.required]: {}, [Trait.nullable]: {} },
    });
  });

  it("opens response enums, and keeps literals and request enums closed", () => {
    expect(shape<StructureShape>(model, "WidgetState").traits).toEqual({ [Trait.open]: true });
    expect(shape<StructureShape>(model, "WidgetKind").traits).toBeUndefined();
    expect(shape<StructureShape>(model, "WidgetsListRequestSortField").traits).toBeUndefined();
  });

  it("finds the discriminator of a union with an open variant", () => {
    const union = shape<StructureShape>(model, "WidgetData");

    expect(union.traits).toEqual({ [Trait.discriminator]: "_tag" });
    expect(Object.keys(union.members)).toEqual(["twitter", "other"]);
    expect(shape<StructureShape>(model, "WidgetDataOther").traits).toEqual({ [Trait.open]: true });
  });

  it("refuses to finalize twice", () => {
    expect(() => finalize(model)).toThrow("already finalized");
  });
});

describe("the committed model", () => {
  it("is what convert produces from the committed spec and patches", () => {
    const root = resolve(import.meta.dirname, "../..");

    expect(serialize(buildModel(root).model)).toBe(readFileSync(resolve(root, MODEL_PATH), "utf8"));
  });
});
