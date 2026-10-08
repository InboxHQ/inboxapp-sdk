/**
 * `effect/Schema` with its construction surface typed `any`, for generated service files.
 * Generated consts carry explicit `Schema<T>` annotations, so the compiler never instantiates
 * the Schema generics while checking them. Runtime values are the ones from `effect/Schema`.
 *
 * Adapted from `@distilled.cloud/core/schema` (Apache-2.0, see NOTICE).
 */
export * from "effect/Schema";

import * as S from "effect/Schema";

type AnyFn = (...args: any[]) => any;

export const optional: AnyFn = S.optional as AnyFn;
export const Struct: AnyFn = S.Struct as AnyFn;
export const suspend: AnyFn = S.suspend as AnyFn;
export const Array: AnyFn = S.Array as AnyFn;
export const Record: AnyFn = S.Record as AnyFn;
export const Union: AnyFn = S.Union as AnyFn;
export const Literal: AnyFn = S.Literal as AnyFn;
export const Literals: AnyFn = S.Literals as AnyFn;
export const NullOr: AnyFn = S.NullOr as AnyFn;
export const Tuple: AnyFn = S.Tuple as AnyFn;

export const String: any = S.String;
export const Number: any = S.Number;
export const Boolean: any = S.Boolean;
export const Unknown: any = S.Unknown;
export const Null: any = S.Null;
