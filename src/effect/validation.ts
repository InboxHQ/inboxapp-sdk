import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as AST from "effect/SchemaAST";

export type Mode = "lenient" | "strict";

/**
 * `lenient` (the default) returns a 2xx body as read. `strict` decodes it against the operation's
 * output schema and fails with `InboxappParseError` on a mismatch.
 */
export const ResponseValidation = Context.Reference<Mode>("@inboxapp/sdk/ResponseValidation", {
  defaultValue: () => "lenient",
});

export const strict: Layer.Layer<never> = Layer.succeed(ResponseValidation, "strict");

export const lenient: Layer.Layer<never> = Layer.succeed(ResponseValidation, "lenient");

const decoders = new WeakMap<
  AST.AST,
  (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>
>();

/** Succeeds with `value` itself, so both modes return the same thing for a valid body. */
export const validate = <E>(
  output: Schema.Top,
  value: unknown,
  onError: (cause: Schema.SchemaError) => E,
): Effect.Effect<unknown, E> =>
  Effect.flatMap(ResponseValidation, (mode) => {
    if (mode === "lenient") return Effect.succeed(value);
    let decode = decoders.get(output.ast);
    if (!decode) {
      decode = Schema.decodeUnknownEffect(output) as (
        input: unknown,
      ) => Effect.Effect<unknown, Schema.SchemaError>;
      decoders.set(output.ast, decode);
    }
    return decode(value).pipe(Effect.mapError(onError), Effect.as(value));
  });
