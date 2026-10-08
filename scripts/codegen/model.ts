export const NAMESPACE = "com.inboxapp.api";

export const Prelude = {
  String: "smithy.api#String",
  Integer: "smithy.api#Integer",
  Double: "smithy.api#Double",
  Boolean: "smithy.api#Boolean",
  Document: "smithy.api#Document",
  Unit: "smithy.api#Unit",
} as const;

export const Trait = {
  documentation: "smithy.api#documentation",
  required: "smithy.api#required",
  http: "smithy.api#http",
  httpLabel: "smithy.api#httpLabel",
  httpQuery: "smithy.api#httpQuery",
  httpHeader: "smithy.api#httpHeader",
  httpResponseCode: "smithy.api#httpResponseCode",
  error: "smithy.api#error",
  httpError: "smithy.api#httpError",
  retryable: "smithy.api#retryable",
  paginated: "smithy.api#paginated",
  enumValue: "smithy.api#enumValue",
  nullable: "com.inboxapp.codegen#nullable",
  errorMatchers: "com.inboxapp.codegen#errorMatchers",
  queryStyle: "com.inboxapp.codegen#queryStyle",
  open: "com.inboxapp.codegen#open",
  constant: "com.inboxapp.codegen#const",
  tuple: "com.inboxapp.codegen#tuple",
  discriminator: "com.inboxapp.codegen#discriminator",
  namespace: "com.inboxapp.codegen#namespace",
  operationName: "com.inboxapp.codegen#operationName",
  operationId: "com.inboxapp.codegen#operationId",
  webhookEvent: "com.inboxapp.codegen#webhookEvent",
} as const;

export type Traits = Record<string, unknown>;

export interface Member {
  target: string;
  traits?: Traits;
}

export interface StructureShape {
  type: "structure";
  members: Record<string, Member>;
  traits?: Traits;
}

export interface UnionShape {
  type: "union";
  members: Record<string, Member>;
  traits?: Traits;
}

export interface EnumShape {
  type: "enum";
  members: Record<string, Member>;
  traits?: Traits;
}

export interface ListShape {
  type: "list";
  member: Member;
  traits?: Traits;
}

export interface MapShape {
  type: "map";
  key: Member;
  value: Member;
  traits?: Traits;
}

export interface SimpleShape {
  type: "string" | "integer" | "double" | "boolean" | "document";
  traits?: Traits;
}

export interface OperationShape {
  type: "operation";
  input: { target: string };
  output: { target: string };
  errors?: Array<{ target: string }>;
  traits: Traits;
}

export interface ServiceShape {
  type: "service";
  version: string;
  operations: Array<{ target: string }>;
  errors?: Array<{ target: string }>;
  traits: Traits;
}

export type Shape =
  | StructureShape
  | UnionShape
  | EnumShape
  | ListShape
  | MapShape
  | SimpleShape
  | OperationShape
  | ServiceShape;

export interface Model {
  smithy: "2.0";
  metadata: Record<string, unknown>;
  shapes: Record<string, Shape>;
}

export interface HttpTrait {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  uri: string;
  code: number;
}

export interface PaginatedTrait {
  mode: "cursor" | "sequence";
  inputToken: string;
  outputToken: string;
  items: string;
  pageSize?: string;
  hasNextPage?: string;
}

export interface ErrorMatcher {
  code: string;
}

export const shapeId = (name: string) => `${NAMESPACE}#${name}`;

export const shapeName = (id: string) => id.slice(id.indexOf("#") + 1);

export const isPrelude = (id: string) => id.startsWith("smithy.api#");

export function memberTargets(shape: Shape): Member[] {
  switch (shape.type) {
    case "structure":
    case "union":
      return Object.values(shape.members);
    case "list":
      return [shape.member];
    case "map":
      return [shape.value];
    default:
      return [];
  }
}

export function reachable(model: Model, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id) || isPrelude(id)) continue;
    const shape = model.shapes[id];
    if (!shape) throw new Error(`Dangling shape target: ${id}`);
    seen.add(id);
    for (const member of memberTargets(shape)) queue.push(member.target);
  }
  return seen;
}

export const pascalCase = (value: string) =>
  value
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");

export const camelCase = (value: string) => {
  const pascal = pascalCase(value);
  return pascal.length === 0 ? pascal : pascal[0]!.toLowerCase() + pascal.slice(1);
};
