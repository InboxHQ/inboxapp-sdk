import { shapeName, type Model } from "./model.ts";
import type { OperationView, Sdk, ServiceView } from "./sdk.ts";
import { BANNER, declaration, doc, memberType, propertyKey, typeOf } from "./typescript.ts";

const types = (name: string) => `T.${name}`;

export const fileName = (namespace: string) =>
  namespace.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** The default client: plain TypeScript with no runtime dependency. */
export function emitClient(sdk: Sdk): Map<string, string> {
  const files = new Map<string, string>();
  files.set("types.ts", emitTypes(sdk.model));
  files.set("operations.ts", emitOperations(sdk));
  files.set("errors.ts", emitErrors(sdk));
  files.set("webhooks.ts", emitEvents(sdk));

  const members: AggregateMember[] = [];
  for (const service of sdk.services) {
    const path = `./${fileName(service.namespace)}.ts`;
    files.set(path.slice(2), emitService(sdk, service));
    members.push({
      property: service.namespace,
      className: service.className,
      path,
      documentation: service.documentation,
    });
  }
  files.set("index.ts", emitAggregate("Services", members));
  return files;
}

interface AggregateMember {
  property: string;
  className: string;
  path: string;
  documentation?: string;
}

function emitAggregate(className: string, members: AggregateMember[]): string {
  return [
    BANNER,
    `import type { Transport } from "../transport.ts";`,
    ...members.map((entry) => `import { ${entry.className} } from "${entry.path}";`),
    "",
    `export class ${className} {`,
    ...members.map(
      (entry) =>
        `${doc(entry.documentation, "  ")}  readonly ${entry.property}: ${entry.className};`,
    ),
    "",
    "  constructor(transport: Transport) {",
    ...members.map((entry) => `    this.${entry.property} = new ${entry.className}(transport);`),
    "  }",
    "}",
    "",
  ].join("\n");
}

function emitTypes(model: Model): string {
  const declarations = Object.entries(model.shapes)
    .map(([id, shape]) => declaration(model, id, shape))
    .filter((text) => text !== undefined);
  return `${BANNER}\n${declarations.join("\n")}`;
}

function emitOperations(sdk: Sdk): string {
  const constants = sdk.operations.map((operation) => {
    const descriptor = {
      id: operation.operationId,
      method: operation.http.method,
      path: operation.http.uri,
      ...(operation.labels.length > 0 ? { labels: operation.labels } : {}),
      ...(Object.keys(operation.query).length > 0 ? { query: operation.query } : {}),
      ...(Object.keys(operation.headers).length > 0 ? { headers: operation.headers } : {}),
      ...(operation.hasBody ? { hasBody: true } : {}),
      ...(operation.responseCode ? { responseCode: operation.responseCode } : {}),
      ...(operation.paginated ? { pagination: operation.paginated } : {}),
    };
    return `export const ${operation.key} = ${JSON.stringify(descriptor)} as const satisfies OperationDescriptor;\n`;
  });
  return [BANNER, `import type { OperationDescriptor } from "../wire.ts";`, "", ...constants].join(
    "\n",
  );
}

function emitErrors(sdk: Sdk): string {
  const classes = sdk.errors.map((error) => {
    const details = memberType(sdk.model, error.details, types);
    return (
      `/** \`${error.status} ${error.code}\` */\n` +
      `export class ${error.name} extends ApiError<${JSON.stringify(error.code)}, ${details}> {\n` +
      `  override name = ${JSON.stringify(error.name)};\n}\n`
    );
  });
  const names = (ids: string[]) => ids.map(shapeName);
  const retryable = sdk.errors.filter((error) => error.retryable);

  return [
    BANNER,
    `import { ApiError } from "../errors.ts";`,
    `import type * as T from "./types.ts";`,
    "",
    ...classes,
    "/** The error class of every `code` this SDK version knows. */",
    "export const errorsByCode = {",
    ...sdk.errors.map((error) => `  ${propertyKey(error.code)}: ${error.name},`),
    "} as const;",
    "",
    "export type ErrorsByCode = typeof errorsByCode;",
    "",
    "export type KnownApiError = InstanceType<ErrorsByCode[keyof ErrorsByCode]>;",
    "",
    "/** `throttling` failures were never processed; `transient` ones may have been. */",
    "export const retryableCodes = {",
    ...retryable.map(
      (error) => `  ${propertyKey(error.code)}: ${JSON.stringify(error.retryable)},`,
    ),
    "} as const;",
    "",
    "/** Errors any operation can fail with. */",
    `export type CommonError = ${names(sdk.commonErrors).join(" | ") || "never"};`,
    "",
    ...sdk.operations.map(
      (operation) =>
        `export type ${operation.name}Error = ${[...names(operation.errors), "CommonError"].join(" | ")};\n`,
    ),
  ].join("\n");
}

function emitEvents(sdk: Sdk): string {
  return [
    BANNER,
    `import type * as T from "./types.ts";`,
    "",
    "/** Every webhook event, by its `type`. */",
    "export interface WebhookEvents {",
    ...sdk.events.map((event) => `  ${JSON.stringify(event.type)}: T.${shapeName(event.id)};`),
    "}",
    "",
    "export type WebhookEventType = keyof WebhookEvents;",
    "",
    "export type WebhookEvent = WebhookEvents[WebhookEventType];",
    "",
    `export const webhookEventTypes = ${JSON.stringify(sdk.events.map((event) => event.type))} as const satisfies ReadonlyArray<WebhookEventType>;`,
    "",
  ].join("\n");
}

function emitService(sdk: Sdk, service: ServiceView): string {
  const paginated = service.operations.some((operation) => operation.paginated);
  const plain = service.operations.some((operation) => !operation.paginated);
  const imports = [plain && "Method", paginated && "PaginatedMethod", "Transport"].filter(Boolean);

  return [
    BANNER,
    `import type { ${imports.join(", ")} } from "../transport.ts";`,
    `import * as Operations from "./operations.ts";`,
    `import type * as T from "./types.ts";`,
    "",
    `${doc(service.documentation)}export class ${service.className} {`,
    ...service.operations.map(
      (operation) =>
        doc(methodDocumentation(operation), "  ") +
        `  readonly ${operation.method}: ${methodType(sdk.model, operation)};`,
    ),
    "",
    "  constructor(transport: Transport) {",
    ...service.operations.map(
      (operation) =>
        `    this.${operation.method} = transport.${operation.paginated ? "paginated" : "method"}(Operations.${operation.key});`,
    ),
    "  }",
    "}",
    "",
  ].join("\n");
}

const methodDocumentation = (operation: OperationView) =>
  [
    operation.documentation,
    `\`${operation.http.method} ${operation.http.uri}\``,
    `@throws {${operation.name}Error}`,
  ]
    .filter(Boolean)
    .join("\n\n");

export function methodType(model: Model, operation: OperationView): string {
  const input = types(shapeName(operation.input));
  const output = outputType(model, operation, types);
  if (!operation.paginated) return `Method<${input}, ${output}>`;
  return `PaginatedMethod<${input}, ${output}, ${itemType(model, operation, types)}>`;
}

export const outputType = (
  model: Model,
  operation: OperationView,
  qualify: (name: string) => string,
) => (operation.output ? typeOf(model, operation.output, qualify) : "void");

export function itemType(
  model: Model,
  operation: OperationView,
  qualify: (name: string) => string,
): string {
  const page = model.shapes[operation.output!];
  const items = page?.type === "structure" ? page.members[operation.paginated!.items] : undefined;
  const list = items ? model.shapes[items.target] : undefined;
  if (list?.type !== "list") throw new Error(`${operation.operationId}: items must be a list`);
  return memberType(model, list.member, qualify);
}
