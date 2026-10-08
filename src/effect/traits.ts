import type * as AST from "effect/SchemaAST";
import type {
  HttpMethod,
  OperationDescriptor,
  Pagination,
  QueryBinding,
  QueryStyle,
} from "../wire.ts";

interface Annotatable {
  annotate(annotations: any): Annotatable;
}

const annotation =
  (key: symbol, value: unknown) =>
  <A extends Annotatable>(schema: A): A =>
    schema.annotate({ [key]: value }) as A;

export interface HttpTrait {
  readonly method: HttpMethod;
  readonly uri: string;
  readonly code: number;
}

export const httpSymbol = Symbol.for("@inboxapp/sdk/http");
export const labelSymbol = Symbol.for("@inboxapp/sdk/http/label");
export const querySymbol = Symbol.for("@inboxapp/sdk/http/query");
export const headerSymbol = Symbol.for("@inboxapp/sdk/http/header");
export const responseCodeSymbol = Symbol.for("@inboxapp/sdk/http/response-code");
export const errorMatchersSymbol = Symbol.for("@inboxapp/sdk/error-matchers");

/** The request line, stamped on an operation's input schema. */
export const Http = (trait: HttpTrait) => annotation(httpSymbol, trait);

/** Fills the `{member}` placeholder of the URI. */
export const Label = () => annotation(labelSymbol, true);

/** `form` repeats the key for arrays; `deepObject` nests objects and arrays in brackets. */
export const Query = (name: string, style: QueryStyle = "form") =>
  annotation(querySymbol, { name, style } satisfies QueryBinding);

export const Header = (name: string) => annotation(headerSymbol, name);

/** An output member that receives the HTTP status instead of a body field. */
export const ResponseCode = () => annotation(responseCodeSymbol, true);

export interface ErrorMatcher {
  readonly code: string;
}

export const applyErrorMatchers = <C>(cls: C, matchers: ReadonlyArray<ErrorMatcher>): C => {
  (cls as any)[errorMatchersSymbol] = matchers;
  return cls;
};

export const getErrorMatchers = (cls: unknown): ReadonlyArray<ErrorMatcher> =>
  (cls as any)?.[errorMatchersSymbol] ?? [];

export function annotationOf(ast: AST.AST, key: symbol): unknown {
  const direct = (ast.annotations as Record<symbol, unknown> | undefined)?.[key];
  if (direct !== undefined) return direct;
  if (ast._tag === "Suspend") return annotationOf(ast.thunk(), key);
  if (ast._tag === "Union") {
    const present = ast.types.filter((type) => type._tag !== "Undefined" && type._tag !== "Null");
    if (present.length === 1) return annotationOf(present[0]!, key);
  }
  return undefined;
}

export function propertiesOf(ast: AST.AST): ReadonlyArray<AST.PropertySignature> {
  if (ast._tag === "Objects") return ast.propertySignatures;
  if (ast._tag === "Suspend") return propertiesOf(ast.thunk());
  return [];
}

/** Reads the traits of an operation's input and output schemas back into a wire descriptor. */
export function describe(
  id: string,
  input: AST.AST,
  output: AST.AST | undefined,
  pagination: Pagination | undefined,
): OperationDescriptor {
  const http = annotationOf(input, httpSymbol) as HttpTrait | undefined;
  if (!http) throw new Error(`${id}: the input schema is missing the Http() trait`);

  const labels: string[] = [];
  const query: Record<string, QueryBinding> = {};
  const headers: Record<string, string> = {};
  let hasBody = false;
  for (const property of propertiesOf(input)) {
    const name = String(property.name);
    const queryBinding = annotationOf(property.type, querySymbol) as QueryBinding | undefined;
    const header = annotationOf(property.type, headerSymbol) as string | undefined;
    if (annotationOf(property.type, labelSymbol) !== undefined) labels.push(name);
    else if (queryBinding) query[name] = queryBinding;
    else if (header) headers[name] = header;
    else hasBody = true;
  }

  const responseCode = (output ? propertiesOf(output) : []).find(
    (property) => annotationOf(property.type, responseCodeSymbol) !== undefined,
  );
  return {
    id,
    method: http.method,
    path: http.uri,
    labels,
    query,
    headers,
    hasBody,
    ...(responseCode ? { responseCode: String(responseCode.name) } : {}),
    ...(pagination ? { pagination } : {}),
  };
}
