import { Inboxapp, isApiError, RateLimited } from "@inboxapp/sdk";

const inbox = new Inboxapp({ token: process.env.INBOX_API_TOKEN! });

const page = await inbox.threads.list({
  folder: "all",
  expand: ["profile"],
  q: "Kevin Picchi",
  limit: 1,
});

try {
  const thread = page.data[0];
  if (thread) {
    const sent = await inbox.messages.send({
      target: { type: "thread", threadId: page.data[0]!.id },
      content: "Sending from the SDK!",
      idempotencyKey: "sdk-test-1",
    });

    const name = thread.profile?.displayName || "unknown";
    console.log(
      sent.message.id,
      (sent.httpStatus === 200 ? "already sent to " : "sent to ") + name,
    );
  } else {
    console.log("Thread not found!");
  }
} catch (error) {
  if (error instanceof RateLimited) {
    console.log(`Rate limited until ${error.details.resetAt}`);
  } else if (isApiError(error, "capabilityNotSupported")) {
    console.log(`This account can't ${error.details.capability}`);
  } else if (isApiError(error)) {
    console.log(error.status, error.code, error.message, error.requestId);
  } else {
    throw error;
  }
}
