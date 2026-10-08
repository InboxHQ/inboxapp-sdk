import {
  camelCase,
  isPrelude,
  pascalCase,
  shapeName,
  Trait,
  type ErrorMatcher,
  type HttpTrait,
  type Member,
  type Model,
  type OperationShape,
  type PaginatedTrait,
  type ServiceShape,
  type Shape,
  type StructureShape,
} from "./model.ts";

export interface QueryBinding {
  name: string;
  style: "form" | "deepObject";
}

export interface OperationView {
  /** `ThreadsList` */
  name: string;
  /** `threadsList` */
  key: string;
  /** `list` */
  method: string;
  /** `threads.list` */
  operationId: string;
  http: HttpTrait;
  documentation?: string;
  input: string;
  inputShape: StructureShape;
  /** Undefined when the operation answers without a body. */
  output?: string;
  errors: string[];
  paginated?: PaginatedTrait;
  labels: string[];
  query: Record<string, QueryBinding>;
  headers: Record<string, string>;
  hasBody: boolean;
  responseCode?: string;
}

export interface ServiceView {
  /** `Threads` */
  className: string;
  /** `threads` */
  namespace: string;
  documentation?: string;
  operations: OperationView[];
}

export interface ErrorView {
  id: string;
  name: string;
  code: string;
  status: number;
  retryable?: "transient" | "throttling";
  details: Member;
}

export interface Sdk {
  model: Model;
  services: ServiceView[];
  operations: OperationView[];
  errors: ErrorView[];
  commonErrors: string[];
  events: Array<{ type: string; id: string }>;
}

export function analyze(model: Model): Sdk {
  const services: ServiceView[] = [];
  const errorIds: string[] = [];
  let commonErrors: string[] | undefined;

  for (const shape of Object.values(model.shapes)) {
    if (shape.type !== "service") continue;
    const service = shape as ServiceShape;
    const namespace = service.traits[Trait.namespace] as string;
    const common = (service.errors ?? []).map((error) => error.target);
    if (commonErrors && commonErrors.join() !== common.join()) {
      throw new Error("Every service must declare the same common errors");
    }
    commonErrors = common;
    errorIds.push(...common);

    const operations = service.operations.map((reference) =>
      operationView(model, reference.target),
    );
    for (const operation of operations) errorIds.push(...operation.errors);
    services.push({
      className: pascalCase(namespace),
      namespace,
      documentation: service.traits[Trait.documentation] as string | undefined,
      operations,
    });
  }

  const events = Object.entries(model.shapes)
    .filter(([, shape]) => shape.traits?.[Trait.webhookEvent] !== undefined)
    .map(([id, shape]) => ({ type: shape.traits![Trait.webhookEvent] as string, id }));

  return {
    model,
    services,
    operations: services.flatMap((service) => service.operations),
    errors: [...new Set(errorIds)].map((id) => errorView(model, id)),
    commonErrors: commonErrors ?? [],
    events,
  };
}

function operationView(model: Model, id: string): OperationView {
  const shape = model.shapes[id] as OperationShape;
  const inputShape = model.shapes[shape.input.target];
  if (inputShape?.type !== "structure") throw new Error(`${id}: the input must be a structure`);

  const labels: string[] = [];
  const query: Record<string, QueryBinding> = {};
  const headers: Record<string, string> = {};
  let hasBody = false;
  for (const [name, member] of Object.entries(inputShape.members)) {
    const traits = member.traits ?? {};
    if (Trait.httpLabel in traits) labels.push(name);
    else if (Trait.httpQuery in traits) {
      query[name] = {
        name: traits[Trait.httpQuery] as string,
        style: traits[Trait.queryStyle] === "deepObject" ? "deepObject" : "form",
      };
    } else if (Trait.httpHeader in traits) headers[name] = traits[Trait.httpHeader] as string;
    else hasBody = true;
  }

  const output = isPrelude(shape.output.target) ? undefined : shape.output.target;
  const outputShape = output ? model.shapes[output] : undefined;
  const responseCode =
    outputShape?.type === "structure"
      ? Object.entries(outputShape.members).find(
          ([, member]) => member.traits && Trait.httpResponseCode in member.traits,
        )?.[0]
      : undefined;

  const name = shapeName(id);
  return {
    name,
    key: camelCase(name),
    method: shape.traits[Trait.operationName] as string,
    operationId: shape.traits[Trait.operationId] as string,
    http: shape.traits[Trait.http] as HttpTrait,
    documentation: shape.traits[Trait.documentation] as string | undefined,
    input: shape.input.target,
    inputShape,
    output,
    errors: (shape.errors ?? []).map((error) => error.target),
    paginated: shape.traits[Trait.paginated] as PaginatedTrait | undefined,
    labels,
    query,
    headers,
    hasBody,
    responseCode,
  };
}

function errorView(model: Model, id: string): ErrorView {
  const shape = model.shapes[id];
  const traits = shape?.traits ?? {};
  const matchers = traits[Trait.errorMatchers] as ErrorMatcher[] | undefined;
  if (shape?.type !== "structure" || !matchers?.[0] || !shape.members.details) {
    throw new Error(`${id} is not an error shape`);
  }
  const retryable = traits[Trait.retryable] as { throttling?: boolean } | undefined;
  return {
    id,
    name: shapeName(id),
    code: matchers[0].code,
    status: traits[Trait.httpError] as number,
    retryable: retryable ? (retryable.throttling ? "throttling" : "transient") : undefined,
    details: shape.members.details,
  };
}

/** Lists, maps, literals and constants are written inline where they are used; the rest get a name. */
export function isNamed(shape: Shape): boolean {
  switch (shape.type) {
    case "structure":
      return !isError(shape);
    case "union":
      return true;
    case "enum":
      return Object.keys(shape.members).length > 1;
    case "list":
    case "map":
    case "operation":
    case "service":
      return false;
    default:
      return shape.traits?.[Trait.constant] === undefined;
  }
}

/** An error body is not a type of its own: each client has a class for it. */
export const isError = (shape: Shape) => Trait.error in (shape.traits ?? {});

export const enumValues = (shape: Extract<Shape, { type: "enum" }>): string[] =>
  Object.values(shape.members).map((member) => member.traits![Trait.enumValue] as string);

export const isRequired = (member: Member) => Trait.required in (member.traits ?? {});

export const isNullable = (member: Member) => Trait.nullable in (member.traits ?? {});

export const documentationOf = (holder: { traits?: Record<string, unknown> }) =>
  holder.traits?.[Trait.documentation] as string | undefined;
