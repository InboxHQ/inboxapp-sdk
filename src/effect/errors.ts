import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import * as Category from "./category.ts";

/** A wait hint from `Retry-After` or `details.retryAfterSeconds`, read by the retry policy. */
export const DurationSchema = Schema.declare<Duration.Duration>(Duration.isDuration);

/**
 * The `details` of an error class: typed from the spec, never checked at runtime, so a body the
 * spec did not foresee still fails with its own class.
 */
export const Details = <A>(): Schema.Schema<A> => Schema.Unknown as unknown as Schema.Schema<A>;

/** A failure whose `code` this SDK version does not know, or a response without the error body. */
export class UnknownInboxappError extends Schema.TaggedError<UnknownInboxappError>()(
  "UnknownInboxappError",
  {
    status: Schema.Number,
    code: Schema.optional(Schema.String),
    message: Schema.String,
    requestId: Schema.optional(Schema.String),
    body: Schema.Unknown,
    retryAfter: Schema.optional(DurationSchema),
  },
) {}

/** A 2xx body that does not match the operation's output schema. Only raised in strict mode. */
export class InboxappParseError extends Schema.TaggedError<InboxappParseError>()(
  "InboxappParseError",
  {
    body: Schema.Unknown,
    cause: Schema.Unknown,
  },
).pipe(Category.withParseError) {}
