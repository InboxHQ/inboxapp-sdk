import { fileName, itemType, outputType } from "./emit-client.ts";
import { pascalCase, Prelude, shapeName, Trait, type Member, type Model } from "./model.ts";
import {
  enumValues,
  isNamed,
  isNullable,
  isRequired,
  type ErrorView,
  type OperationView,
  type Sdk,
  type ServiceView,
} from "./sdk.ts";
import { BANNER, doc, memberType, propertyKey } from "./typescript.ts";

const PURE = "/*@__PURE__*/";

type Qualify = (name: string) => string;

const local: Qualify = (name) => name;
const fromModel: Qualify = (name) => `Model.${name}`;
const types: Qualify = (name) => `M.${name}`;

/** The Effect client: one module of operations per service, over shared schemas and error classes. */
export function emitEffect(sdk: Sdk): Map<string, string> {
  const files = new Map<string, string>();
  files.set("schemas.ts", emitSchemas(sdk));
  files.set("errors.ts", emitErrors(sdk));
  files.set("webhooks.ts", emitEvents(sdk));

  const exports: string[] = [];
  for (const service of sdk.services) {
    const file = `${fileName(service.namespace)}.ts`;
    files.set(file, emitService(sdk, service));
    exports.push(`${doc(service.documentation)}export * as ${service.namespace} from "./${file}";`);
  }
  files.set("index.ts", `${BANNER}\n${exports.join("\n")}\n`);
  return files;
}

function schemaOf(model: Model, target: string, qualify: Qualify): string {
  switch (target) {
    case Prelude.String:
      return `S.String`;
    case Prelude.Integer:
    case Prelude.Double:
      return `S.Number`;
    case Prelude.Boolean:
      return `S.Boolean`;
    case Prelude.Document:
      return `S.Unknown`;
    case Prelude.Unit:
      return `S.Null`;
  }
  const shape = model.shapes[target];
  if (!shape) throw new Error(`Dangling shape target: ${target}`);
  if (isNamed(shape)) return qualify(shapeName(target));

  switch (shape.type) {
    case "enum":
      return `S.Literal(${JSON.stringify(enumValues(shape)[0])})`;
    case "list": {
      const item = nullable(model, shape.member, qualify);
      const length = shape.traits?.[Trait.tuple] as number | undefined;
      return length ? `S.Tuple([${Array(length).fill(item).join(", ")}])` : `S.Array(${item})`;
    }
    case "map":
      return `S.Record(S.String, ${nullable(model, shape.value, qualify)})`;
    default:
      return `S.Literal(${JSON.stringify(shape.traits?.[Trait.constant])})`;
  }
}

function nullable(model: Model, member: Member, qualify: Qualify): string {
  const schema = schemaOf(model, member.target, qualify);
  return isNullable(member) ? `S.NullOr(${schema})` : schema;
}

function memberSchema(model: Model, member: Member, qualify: Qualify): string {
  const traits = member.traits ?? {};
  const base = nullable(model, member, qualify);
  const schema = isRequired(member) ? base : `S.optional(${base})`;

  const pipes: string[] = [];
  if (Trait.httpLabel in traits) pipes.push("T.Label()");
  if (Trait.httpQuery in traits) {
    const style = traits[Trait.queryStyle] === "deepObject" ? `, "deepObject"` : "";
    pipes.push(`T.Query(${JSON.stringify(traits[Trait.httpQuery])}${style})`);
  }
  if (Trait.httpHeader in traits)
    pipes.push(`T.Header(${JSON.stringify(traits[Trait.httpHeader])})`);
  if (Trait.httpResponseCode in traits) pipes.push("T.ResponseCode()");
  return pipes.length > 0 ? `${schema}.pipe(${pipes.join(", ")})` : schema;
}

function structSchema(
  model: Model,
  members: Record<string, Member>,
  qualify: Qualify,
  pipe = "",
): string {
  const fields = Object.entries(members).map(
    ([key, member]) => `${propertyKey(key)}: ${memberSchema(model, member, qualify)},`,
  );
  return `S.suspend(() => S.Struct({\n${fields.join("\n")}\n})${pipe})`;
}

function emitSchemas(sdk: Sdk): string {
  const { model } = sdk;
  const inputs = new Set(sdk.operations.map((operation) => operation.input));
  let usesTraits = false;

  const declarations: string[] = [];
  for (const [id, shape] of Object.entries(model.shapes)) {
    if (!isNamed(shape) || inputs.has(id)) continue;
    const name = shapeName(id);
    let schema: string;
    switch (shape.type) {
      case "structure":
        schema = `${structSchema(model, shape.members, local)}.annotate({ identifier: ${JSON.stringify(name)} })`;
        usesTraits ||= schema.includes("T.ResponseCode()");
        break;
      case "union": {
        const variants = Object.values(shape.members).map((member) =>
          schemaOf(model, member.target, local),
        );
        schema = `S.suspend(() => S.Union([${variants.join(", ")}])).annotate({ identifier: ${JSON.stringify(name)} })`;
        break;
      }
      case "enum":
        schema = shape.traits?.[Trait.open]
          ? "S.String"
          : `S.Literals(${JSON.stringify(enumValues(shape))})`;
        break;
      default:
        schema = schemaOf(model, `smithy.api#${pascalCase(shape.type)}`, local);
    }
    declarations.push(
      `export type ${name} = M.${name};\n` +
        `export const ${name} = ${PURE} ${schema} as any as S.Schema<M.${name}>;\n`,
    );
  }

  return [
    BANNER,
    `import type * as M from "../../services/types.ts";`,
    `import * as S from "../schema.ts";`,
    ...(usesTraits ? [`import * as T from "../traits.ts";`] : []),
    "",
    ...declarations,
  ].join("\n");
}

const CATEGORY_BY_STATUS: Record<number, string> = {
  400: "withBadRequestError",
  401: "withAuthError",
  402: "withQuotaError",
  403: "withAuthError",
  404: "withNotFoundError",
  409: "withConflictError",
  422: "withBadRequestError",
  429: "withThrottlingError",
};

function errorPipes(error: ErrorView): string[] {
  const category =
    CATEGORY_BY_STATUS[error.status] ?? (error.status >= 500 ? "withServerError" : "");
  const pipes = category ? [`Category.${category}`] : [];
  if (error.retryable === "throttling") pipes.push("Category.withRetryable({ throttling: true })");
  if (error.retryable === "transient") pipes.push("Category.withRetryable()");
  return pipes;
}

function emitErrors(sdk: Sdk): string {
  const classes = sdk.errors.map((error) => {
    const fields = [
      `code: Schema.Literal(${JSON.stringify(error.code)}),`,
      "message: Schema.String,",
      `details: Details<${memberType(sdk.model, error.details, types)}>(),`,
      "requestId: Schema.String,",
      ...(error.retryable ? ["retryAfter: Schema.optional(DurationSchema),"] : []),
    ];
    const pipes = errorPipes(error);
    return [
      `/** \`${error.status} ${error.code}\` */`,
      `export class ${error.name} extends ${PURE} T.applyErrorMatchers(`,
      `  ${PURE} Schema.TaggedError<${error.name}>()(${JSON.stringify(error.name)}, {`,
      ...fields.map((field) => `    ${field}`),
      `  })${pipes.length > 0 ? `.pipe(${pipes.join(", ")})` : ""},`,
      `  [{ code: ${JSON.stringify(error.code)} }],`,
      ") {}",
      "",
    ].join("\n");
  });
  const common = sdk.commonErrors.map(shapeName);

  return [
    BANNER,
    `import * as Schema from "effect/Schema";`,
    `import * as Category from "../category.ts";`,
    `import type * as M from "../../services/types.ts";`,
    `import { Details, DurationSchema } from "../errors.ts";`,
    `import * as T from "../traits.ts";`,
    "",
    ...classes,
    "/** Errors any operation can fail with. */",
    `export const COMMON_ERRORS = [${common.join(", ")}] as const;`,
    "",
    "export type CommonError = InstanceType<(typeof COMMON_ERRORS)[number]>;",
    "",
  ].join("\n");
}

function emitEvents(sdk: Sdk): string {
  const names = sdk.events.map((event) => shapeName(event.id));
  return [
    BANNER,
    `import type * as Plain from "../../services/webhooks.ts";`,
    `import * as S from "../schema.ts";`,
    `import * as Model from "./schemas.ts";`,
    "",
    "/** The schema of every webhook event, by its `type`. */",
    "export const byType = {",
    ...sdk.events.map((event) => `  ${JSON.stringify(event.type)}: Model.${shapeName(event.id)},`),
    "} as const;",
    "",
    "export type WebhookEvent = Plain.WebhookEvent;",
    `export const WebhookEvent = ${PURE} S.Union([${names.map(fromModel).join(", ")}]) as any as S.Schema<Plain.WebhookEvent>;`,
    "",
  ].join("\n");
}

function emitService(sdk: Sdk, service: ServiceView): string {
  const usesErrors = service.operations.some((operation) => operation.errors.length > 0);
  const usesModel = service.operations.some(
    (operation) =>
      operation.output !== undefined ||
      Object.values(operation.inputShape.members).some((member) =>
        memberSchema(sdk.model, member, fromModel).includes("Model."),
      ),
  );

  return [
    BANNER,
    `import type * as M from "../../services/types.ts";`,
    `import * as API from "../api.ts";`,
    `import { InboxappProtocol, type InboxappOpContext, type InboxappOpError } from "../protocol.ts";`,
    `import * as Retry from "../retry.ts";`,
    `import * as S from "../schema.ts";`,
    `import * as T from "../traits.ts";`,
    ...(usesErrors ? [`import * as E from "./errors.ts";`] : []),
    ...(usesModel ? [`import * as Model from "./schemas.ts";`] : []),
    "",
    ...service.operations.map((operation) => emitOperation(sdk.model, operation)),
  ].join("\n");
}

const RESERVED = new Set([
  "delete",
  "new",
  "import",
  "export",
  "default",
  "in",
  "function",
  "class",
]);

function emitOperation(model: Model, operation: OperationView): string {
  const pascal = pascalCase(operation.method);
  const constant = RESERVED.has(operation.method) ? `${operation.method}_` : operation.method;
  const request = shapeName(operation.input);
  const http = `.pipe(T.Http(${JSON.stringify(operation.http)}))`;
  const errors = operation.errors.map((id) => `E.${shapeName(id)}`);

  const input = types(request);
  const output = outputType(model, operation, types);
  const signature = operation.paginated
    ? `API.PaginatedOperationMethod<${input}, ${output}, ${pascal}Error, InboxappOpContext, ${itemType(model, operation, types)}>`
    : `API.OperationMethod<${input}, ${output}, ${pascal}Error, InboxappOpContext>`;

  const config = [
    `id: ${JSON.stringify(operation.operationId)},`,
    `input: ${pascal}Request,`,
    ...(operation.output ? [`output: ${schemaOf(model, operation.output, fromModel)},`] : []),
    ...(errors.length > 0 ? [`errors: [${errors.join(", ")}],`] : []),
    "protocol: InboxappProtocol,",
    "retry: Retry.Retry,",
    ...(operation.paginated ? [`pagination: ${JSON.stringify(operation.paginated)},`] : []),
  ];

  return [
    `export type ${pascal}Request = ${input};`,
    `export const ${pascal}Request = ${PURE} ${structSchema(model, operation.inputShape.members, fromModel, http)}.annotate({ identifier: ${JSON.stringify(request)} }) as any as S.Schema<${input}>;`,
    "",
    `export type ${pascal}Error = ${[...errors, "InboxappOpError"].join(" | ")};`,
    `${doc(operation.documentation)}${constant === operation.method ? "export " : ""}const ${constant}: ${signature} = ${PURE} API.${operation.paginated ? "makePaginated" : "make"}(() => ({`,
    ...config.map((line) => `  ${line}`),
    "}));",
    ...(constant === operation.method ? [] : [`export { ${constant} as ${operation.method} };`]),
    "",
  ].join("\n");
}
