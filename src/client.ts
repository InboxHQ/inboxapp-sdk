import { Services } from "./services/index.ts";
import { Transport, type ClientOptions } from "./transport.ts";

/**
 * The Inboxapp API v2 client.
 *
 * ```ts
 * const inbox = new Inboxapp({ token: process.env.INBOX_API_TOKEN! });
 * const page = await inbox.threads.list({ folder: "inbox" });
 * ```
 */
export class Inboxapp extends Services {
  constructor(options: ClientOptions) {
    super(new Transport(options));
  }
}
