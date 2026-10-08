import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { DEFAULT_BASE_URL } from "../wire.ts";

export interface Settings {
  readonly token: Redacted.Redacted<string>;
  readonly baseUrl: string;
}

/** Holds an effect, resolved on every request, so a layer can rotate the token. */
export class Credentials extends Context.Service<Credentials, Effect.Effect<Settings>>()(
  "@inboxapp/sdk/Credentials",
) {}

export const fromToken = (options: {
  readonly token: Redacted.Redacted<string>;
  readonly baseUrl?: string;
}): Layer.Layer<Credentials> =>
  Layer.succeed(
    Credentials,
    Effect.succeed({ token: options.token, baseUrl: options.baseUrl ?? DEFAULT_BASE_URL }),
  );

/** Reads `INBOX_API_TOKEN` (required) and `INBOX_API_BASE_URL` (optional). */
export const CredentialsFromEnv: Layer.Layer<Credentials, Config.ConfigError> = Layer.effect(
  Credentials,
  Effect.gen(function* () {
    const token = yield* Config.Redacted("INBOX_API_TOKEN");
    const baseUrl = yield* Config.String("INBOX_API_BASE_URL").pipe(
      Config.withDefault(DEFAULT_BASE_URL),
    );
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.succeed({ token, baseUrl });
  }),
);
