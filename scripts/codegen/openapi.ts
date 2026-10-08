import {
  camelCase,
  pascalCase,
  Prelude,
  shapeId,
  Trait,
  type EnumShape,
  type HttpTrait,
  type Member,
  type Model,
  type OperationShape,
  type PaginatedTrait,
  type ServiceShape,
  type Shape,
  type StructureShape,
  type Traits,
  type UnionShape,
} from "./model.ts";

type Json = Record<string, any>;

export interface ConvertOptions {
  /** Statuses whose errors are stamped `smithy.api#retryable`; patches refine individual codes. */
  readonly retryableStatuses: Readonly<Record<number, { throttling?: boolean }>>;
}

interface Resolved {
  target: string;
  nullable: boolean;
  documentation?: string;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const NON_FINITE = ["Infinity", "-Infinity", "NaN"];

export function convertOpenApi(document: Json, options: ConvertOptions): Model {
  return new Converter(document, options).convert();
}

class Converter {
  private readonly shapes: Record<string, Shape> = {};
  private readonly names = new Set<string>();
  private readonly componentIds = new Map<string, string>();
  private readonly errorStatuses = new Map<string, Set<number>>();
  private readonly services = new Map<string, ServiceShape>();
  private readonly document: Json;
  private readonly options: ConvertOptions;

  constructor(document: Json, options: ConvertOptions) {
    this.document = document;
    this.options = options;
  }

  convert(): Model {
    for (const [path, item] of Object.entries<Json>(this.document.paths ?? {})) {
      for (const method of METHODS) {
        if (item[method]) this.operation(path, method, item[method]);
      }
    }
    this.stampErrors();
    this.hoistCommonErrors();
    this.webhooks();

    const serviceShapes: Record<string, Shape> = {};
    for (const [name, service] of this.services) serviceShapes[shapeId(name)] = service;

    return {
      smithy: "2.0",
      metadata: {
        "inboxapp.openapi": {
          title: this.document.info.title,
          version: this.document.info.version,
        },
      },
      shapes: { ...serviceShapes, ...this.shapes },
    };
  }

  private operation(path: string, method: (typeof METHODS)[number], operation: Json) {
    const operationId: string = operation.operationId;
    const [serviceKey, operationName, ...rest] = operationId.split(".");
    if (!serviceKey || !operationName || rest.length > 0) {
      throw new Error(`operationId must be "<service>.<operation>": ${operationId}`);
    }
    const name = pascalCase(serviceKey) + pascalCase(operationName);
    const service = this.service(serviceKey, operation);

    const input = this.request(`${name}Request`, operation);
    const { output, code } = this.success(operationId, name, operation);
    const errors = this.errors(operationId, operation);

    const traits: Traits = {
      [Trait.http]: { method: method.toUpperCase(), uri: path, code } as HttpTrait,
      [Trait.operationId]: operationId,
      [Trait.operationName]: operationName,
    };
    const documentation = [operation.summary, operation.description].filter(Boolean).join("\n\n");
    if (documentation) traits[Trait.documentation] = documentation;
    const paginated = this.pagination(input, output);
    if (paginated) traits[Trait.paginated] = paginated;

    const shape: OperationShape = {
      type: "operation",
      input: { target: input },
      output: { target: output },
      errors: errors.map((target) => ({ target })),
      traits,
    };
    this.define(name, shape);
    service.operations.push({ target: shapeId(name) });
  }

  private service(key: string, operation: Json): ServiceShape {
    const name = `${pascalCase(key)}Service`;
    const existing = this.services.get(name);
    if (existing) return existing;

    const tagName: string | undefined = operation.tags?.[0];
    const tag: Json = (this.document.tags ?? []).find((t: Json) => t.name === tagName) ?? {};
    const traits: Traits = { [Trait.namespace]: key };
    if (tag.description) traits[Trait.documentation] = tag.description;
    const service: ServiceShape = {
      type: "service",
      version: this.document.info.version,
      operations: [],
      traits,
    };
    this.reserveExact(name);
    this.services.set(name, service);
    return service;
  }

  private request(name: string, operation: Json): string {
    const members: Record<string, Member> = {};
    const add = (memberName: string, member: Member) => {
      if (members[memberName]) {
        throw new Error(`${name}: "${memberName}" is bound more than once`);
      }
      members[memberName] = member;
    };

    for (const parameter of (operation.parameters ?? []) as Json[]) {
      const memberName = parameter.in === "header" ? camelCase(parameter.name) : parameter.name;
      const resolved = this.schema(parameter.schema, name + pascalCase(memberName));
      const traits: Traits = {};
      if (parameter.in === "path") {
        traits[Trait.httpLabel] = {};
      } else if (parameter.in === "query") {
        traits[Trait.httpQuery] = parameter.name;
        if (parameter.style === "deepObject") traits[Trait.queryStyle] = "deepObject";
        else if (parameter.style !== undefined) {
          throw new Error(`${name}: unsupported query style "${parameter.style}"`);
        }
      } else if (parameter.in === "header") {
        traits[Trait.httpHeader] = headerName(parameter.name);
      } else {
        throw new Error(`${name}: unsupported parameter location "${parameter.in}"`);
      }
      if (parameter.required) traits[Trait.required] = {};
      if (resolved.nullable) traits[Trait.nullable] = {};
      const documentation = parameter.description ?? resolved.documentation;
      if (documentation) traits[Trait.documentation] = documentation;
      add(memberName, { target: resolved.target, traits });
    }

    const body = operation.requestBody?.content?.["application/json"]?.schema;
    if (operation.requestBody && !body) throw new Error(`${name}: only JSON bodies are supported`);
    if (body) {
      if (!body.$ref) throw new Error(`${name}: request body must be a component reference`);
      const shape = this.shapes[this.component(refName(body.$ref))];
      if (shape?.type !== "structure") throw new Error(`${name}: request body must be an object`);
      for (const [memberName, member] of Object.entries(shape.members)) {
        add(memberName, structuredClone(member));
      }
    }

    this.define(name, { type: "structure", members });
    return shapeId(name);
  }

  private success(
    operationId: string,
    name: string,
    operation: Json,
  ): { output: string; code: number } {
    const statuses = Object.keys(operation.responses)
      .map(Number)
      .filter((status) => status >= 200 && status < 300)
      .sort((a, b) => a - b);
    if (statuses.length === 0) throw new Error(`${operationId}: no success response`);

    const schemas = statuses.map(
      (status) => operation.responses[status].content?.["application/json"]?.schema,
    );
    const [schema] = schemas;
    if (schemas.some((other) => JSON.stringify(other) !== JSON.stringify(schema))) {
      throw new Error(`${operationId}: success responses disagree on their schema`);
    }
    if (!schema) return { output: Prelude.Unit, code: statuses[0]! };

    const resolved = this.schema(schema, `${name}Response`);
    if (resolved.nullable || !this.shapes[resolved.target]) {
      throw new Error(`${operationId}: a success response must be an object or an array`);
    }
    return { output: resolved.target, code: statuses[0]! };
  }

  private errors(operationId: string, operation: Json): string[] {
    const targets: string[] = [];
    for (const [status, response] of Object.entries<Json>(operation.responses)) {
      if (Number(status) < 400) continue;
      const schema = response.content?.["application/json"]?.schema;
      const refs: Json[] = schema?.anyOf ?? (schema ? [schema] : []);
      for (const ref of refs) {
        if (!ref.$ref) throw new Error(`${operationId}: ${status} must reference error components`);
        const target = this.component(refName(ref.$ref));
        if (!this.errorStatuses.has(target)) {
          throw new Error(`${operationId}: ${ref.$ref} is not an error envelope`);
        }
        this.errorStatuses.get(target)!.add(Number(status));
        if (!targets.includes(target)) targets.push(target);
      }
    }
    return targets;
  }

  private pagination(input: string, output: string): PaginatedTrait | undefined {
    const request = this.shapes[input] as StructureShape;
    const response = this.shapes[output];
    if (response?.type !== "structure" || !response.members.data) return undefined;
    const pageSize = request.members.limit ? { pageSize: "limit" } : {};

    if (request.members.cursor && response.members.nextCursor) {
      return {
        mode: "cursor",
        inputToken: "cursor",
        outputToken: "nextCursor",
        items: "data",
        ...pageSize,
      };
    }
    if (request.members.afterSeq && response.members.lastSeq && response.members.hasMore) {
      return {
        mode: "sequence",
        inputToken: "afterSeq",
        outputToken: "lastSeq",
        items: "data",
        hasNextPage: "hasMore",
        ...pageSize,
      };
    }
    return undefined;
  }

  private stampErrors() {
    for (const [target, statuses] of this.errorStatuses) {
      if (statuses.size === 0) continue;
      if (statuses.size > 1) {
        throw new Error(`${target} is returned with several statuses: ${[...statuses].join(", ")}`);
      }
      const status = [...statuses][0]!;
      const traits = (this.shapes[target]!.traits ??= {});
      traits[Trait.error] = status >= 500 ? "server" : "client";
      traits[Trait.httpError] = status;
      const retryable = this.options.retryableStatuses[status];
      if (retryable) traits[Trait.retryable] = retryable;
    }
  }

  private hoistCommonErrors() {
    const operations = Object.values(this.shapes).filter(
      (shape): shape is OperationShape => shape.type === "operation",
    );
    const [first, ...others] = operations;
    if (!first) return;
    const common = (first.errors ?? [])
      .map((error) => error.target)
      .filter((target) =>
        others.every((operation) => operation.errors?.some((error) => error.target === target)),
      );
    for (const operation of operations) {
      operation.errors = operation.errors?.filter((error) => !common.includes(error.target));
      if (operation.errors?.length === 0) delete operation.errors;
    }
    for (const service of this.services.values()) {
      const { traits } = service;
      delete (service as Partial<ServiceShape>).traits;
      service.errors = common.map((target) => ({ target }));
      service.traits = traits;
    }
  }

  private webhooks() {
    for (const [type, item] of Object.entries<Json>(this.document.webhooks ?? {})) {
      const schema = item.post?.requestBody?.content?.["application/json"]?.schema;
      if (!schema?.$ref) throw new Error(`webhook ${type}: body must be a component reference`);
      const shape = this.shapes[this.component(refName(schema.$ref))]!;
      (shape.traits ??= {})[Trait.webhookEvent] = type;
    }
  }

  private component(name: string): string {
    const known = this.componentIds.get(name);
    if (known) return known;

    const schema: Json | undefined = this.document.components?.schemas?.[name];
    if (!schema) throw new Error(`Unknown component: ${name}`);

    const errorCode = errorCodeOf(schema);
    const shape = errorCode ? pascalCase(errorCode) : name;
    if (this.names.has(shape)) throw new Error(`Component name is taken: ${shape}`);
    const id = shapeId(shape);
    this.componentIds.set(name, id);
    if (errorCode) this.errorStatuses.set(id, new Set());

    const resolved = this.schema(schema, shape, { exact: true });
    if (resolved.target === id) {
      if (errorCode) {
        (this.shapes[id]!.traits ??= {})[Trait.errorMatchers] = [{ code: errorCode }];
      }
      return id;
    }
    if (resolved.nullable) throw new Error(`Component ${name} cannot be nullable`);
    const simple = SIMPLE[resolved.target];
    if (!simple) {
      this.componentIds.set(name, resolved.target);
      return resolved.target;
    }
    this.names.add(shape);
    this.shapes[id] = {
      type: simple,
      ...(schema.description ? { traits: { [Trait.documentation]: schema.description } } : {}),
    };
    return id;
  }

  private schema(schema: Json, hint: string, options: { exact?: boolean } = {}): Resolved {
    const documentation: string | undefined = schema.description;
    const named = (target: string): Resolved => ({ target, nullable: false, documentation });
    const reserve = () => (options.exact ? this.reserveExact(hint) : this.reserve(hint));

    if (schema.$ref) return named(this.component(refName(schema.$ref)));

    if (schema.allOf) {
      const { allOf, ...own } = schema;
      const candidates: Json[] = [own, ...allOf];
      const parts = candidates.filter((part) => !isAnnotationOnly(part));
      const note =
        candidates
          .map((part) => part.description)
          .filter(Boolean)
          .join(" ") || undefined;
      if (parts.length === 0)
        return { target: Prelude.Document, nullable: false, documentation: note };
      if (parts.length > 1) throw new Error(`${hint}: allOf with several schemas is not supported`);
      const inner = this.schema(parts[0]!, hint, options);
      return { ...inner, documentation: note ?? inner.documentation };
    }

    if (schema.anyOf) {
      if (isNumberWithSentinels(schema)) return named(Prelude.Double);
      const variants = flattenAnyOf(schema.anyOf);
      const present = variants.filter((variant) => variant.type !== "null");
      const nullable = present.length !== variants.length;
      if (present.length === 0) return { target: Prelude.Unit, nullable: false, documentation };
      if (present.length === 1) {
        const inner = this.schema(present[0]!, hint, options);
        return {
          target: inner.target,
          nullable: nullable || inner.nullable,
          documentation: documentation ?? inner.documentation,
        };
      }
      return { ...named(this.union(present, reserve(), documentation)), nullable };
    }

    if (schema.not) return named(Prelude.Document);

    switch (schema.type) {
      case "null":
        return named(Prelude.Unit);
      case "object": {
        if (schema.properties) return named(this.structure(schema, reserve()));
        const name = reserve();
        const values =
          typeof schema.additionalProperties === "object"
            ? this.schema(schema.additionalProperties, `${name}Value`)
            : { target: Prelude.Document, nullable: false };
        this.shapes[shapeId(name)] = {
          type: "map",
          key: { target: Prelude.String },
          value: member(values),
        };
        return named(shapeId(name));
      }
      case "array": {
        const name = reserve();
        const prefix: Json[] | undefined = schema.prefixItems;
        const items = this.schema(prefix ? prefix[0]! : (schema.items ?? {}), `${name}Item`);
        if (prefix) {
          for (const item of prefix.slice(1)) {
            if (this.schema(item, `${name}Item`).target !== items.target) {
              throw new Error(`${hint}: tuples with mixed item types are not supported`);
            }
          }
        }
        this.shapes[shapeId(name)] = {
          type: "list",
          member: member(items),
          ...(prefix ? { traits: { [Trait.tuple]: prefix.length } } : {}),
        };
        return named(shapeId(name));
      }
      case "string": {
        if (!schema.enum) return named(Prelude.String);
        const name = reserve();
        this.shapes[shapeId(name)] = enumShape(schema.enum, documentation);
        return named(shapeId(name));
      }
      case "integer":
        return named(Prelude.Integer);
      case "number":
        return named(Prelude.Double);
      case "boolean": {
        if (!schema.enum) return named(Prelude.Boolean);
        if (schema.enum.length !== 1) throw new Error(`${hint}: unsupported boolean enum`);
        const name = reserve();
        this.shapes[shapeId(name)] = {
          type: "boolean",
          traits: { [Trait.constant]: schema.enum[0] },
        };
        return named(shapeId(name));
      }
      case undefined:
        return named(Prelude.Document);
      default:
        throw new Error(`${hint}: unsupported schema type ${JSON.stringify(schema.type)}`);
    }
  }

  private structure(schema: Json, name: string): string {
    const shape: StructureShape = { type: "structure", members: {} };
    this.shapes[shapeId(name)] = shape;

    const required = new Set<string>(schema.required ?? []);
    for (const [property, propertySchema] of Object.entries<Json>(schema.properties)) {
      const resolved = this.schema(propertySchema, name + pascalCase(property));
      const traits: Traits = {};
      if (required.has(property)) traits[Trait.required] = {};
      if (resolved.nullable) traits[Trait.nullable] = {};
      if (resolved.documentation) traits[Trait.documentation] = resolved.documentation;
      shape.members[property] = {
        target: resolved.target,
        ...(Object.keys(traits).length > 0 ? { traits } : {}),
      };
    }

    const traits: Traits = {};
    if (schema.description) traits[Trait.documentation] = schema.description;
    if (schema.additionalProperties !== false) traits[Trait.open] = true;
    if (Object.keys(traits).length > 0) shape.traits = traits;
    return shapeId(name);
  }

  private union(variants: Json[], name: string, documentation: string | undefined): string {
    const shape: UnionShape = { type: "union", members: {} };
    this.shapes[shapeId(name)] = shape;

    const discriminator = discriminatorOf(variants, this.document);
    const used = new Set<string>();
    variants.forEach((variant, index) => {
      let label = variantLabel(variant, discriminator, this.document);
      if (used.has(label)) label = `${label}${index + 1}`;
      used.add(label);
      const resolved = this.schema(variant, name + label);
      if (resolved.nullable) throw new Error(`${name}: nullable union variants are not supported`);
      shape.members[camelCase(label)] = { target: resolved.target };
    });

    const traits: Traits = {};
    if (documentation) traits[Trait.documentation] = documentation;
    if (discriminator) traits[Trait.discriminator] = discriminator;
    if (Object.keys(traits).length > 0) shape.traits = traits;
    return shapeId(name);
  }

  private define(name: string, shape: Shape) {
    this.reserveExact(name);
    this.shapes[shapeId(name)] = shape;
  }

  private reserveExact(name: string): string {
    if (this.names.has(name)) throw new Error(`Shape name is taken: ${name}`);
    this.names.add(name);
    return name;
  }

  private reserve(hint: string): string {
    let name = hint;
    for (let suffix = 2; this.names.has(name); suffix++) name = `${hint}${suffix}`;
    this.names.add(name);
    return name;
  }
}

const SIMPLE: Record<string, "string" | "integer" | "double" | "boolean" | "document" | undefined> =
  {
    [Prelude.String]: "string",
    [Prelude.Integer]: "integer",
    [Prelude.Double]: "double",
    [Prelude.Boolean]: "boolean",
    [Prelude.Document]: "document",
  };

const refName = (ref: string) => ref.slice(ref.lastIndexOf("/") + 1);

const headerName = (name: string) =>
  name
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1).toLowerCase() : part))
    .join("-");

const member = (resolved: Resolved): Member => ({
  target: resolved.target,
  ...(resolved.nullable ? { traits: { [Trait.nullable]: {} } } : {}),
});

const isAnnotationOnly = (schema: Json) =>
  Object.keys(schema).every((key) => key === "description" || key === "examples");

function isNumberWithSentinels(schema: Json): boolean {
  const variants: Json[] = schema.anyOf;
  if (variants.length !== 2) return false;
  const [number, sentinel] = variants as [Json, Json];
  return (
    (number.type === "number" || number.type === "integer") &&
    sentinel.type === "string" &&
    Array.isArray(sentinel.enum) &&
    sentinel.enum.length === NON_FINITE.length &&
    NON_FINITE.every((value) => sentinel.enum.includes(value))
  );
}

function flattenAnyOf(variants: Json[]): Json[] {
  return variants.flatMap((variant) =>
    variant.anyOf && !isNumberWithSentinels(variant) && Object.keys(variant).length === 1
      ? flattenAnyOf(variant.anyOf)
      : [variant],
  );
}

function errorCodeOf(schema: Json): string | undefined {
  const properties = schema.properties;
  if (schema.type !== "object" || !properties) return undefined;
  const keys = Object.keys(properties).sort().join(",");
  if (keys !== "code,details,message,requestId") return undefined;
  const codes = properties.code.enum;
  return Array.isArray(codes) && codes.length === 1 ? codes[0] : undefined;
}

function enumShape(values: string[], documentation: string | undefined): EnumShape {
  const members: Record<string, Member> = {};
  values.forEach((value, index) => {
    let key = value
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase();
    if (!key || /^[0-9]/.test(key)) key = `VALUE_${key || index}`;
    while (members[key]) key = `${key}_${index}`;
    members[key] = { target: Prelude.Unit, traits: { [Trait.enumValue]: value } };
  });
  return {
    type: "enum",
    members,
    ...(documentation ? { traits: { [Trait.documentation]: documentation } } : {}),
  };
}

const deref = (schema: Json, document: Json): Json =>
  schema.$ref ? document.components.schemas[refName(schema.$ref)] : schema;

function literalOf(schema: Json | undefined): string | undefined {
  return schema?.type === "string" && schema.enum?.length === 1 ? schema.enum[0] : undefined;
}

function discriminatorOf(variants: Json[], document: Json): string | undefined {
  const objects = variants.map((variant) => deref(variant, document));
  if (objects.some((object) => object.type !== "object" || !object.properties)) return undefined;
  const [first] = objects;
  return Object.keys(first!.properties).find((property) => {
    const literals = objects.map((object) => literalOf(object.properties[property]));
    const tagged = literals.filter((literal) => literal !== undefined);
    const isRequired = objects.every((object) => object.required?.includes(property));
    return (
      isRequired &&
      new Set(tagged).size === tagged.length &&
      tagged.length >= objects.length - 1 &&
      tagged.length > 0
    );
  });
}

function variantLabel(variant: Json, discriminator: string | undefined, document: Json): string {
  if (variant.$ref) return refName(variant.$ref);
  if (variant.title) return pascalCase(variant.title);
  const schema = deref(variant, document);
  if (discriminator) {
    const literal = literalOf(schema.properties?.[discriminator]);
    return literal === undefined ? "Other" : pascalCase(literal) || "Other";
  }
  switch (schema.type) {
    case "string":
      return "String";
    case "integer":
    case "number":
      return "Number";
    case "boolean":
      return "Boolean";
    case "array":
      return "List";
    case "object":
      return "Object";
    default:
      return "Variant";
  }
}
