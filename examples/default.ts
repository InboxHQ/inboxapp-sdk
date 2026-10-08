import { Inboxapp, isApiError, RateLimited } from "@inboxapp/sdk";

const inbox = new Inboxapp({ token: process.env.INBOX_API_TOKEN! });

const page = await inbox.threads.list({
  folder: "inbox",
  tag: ["vip", "lead"],
  expand: ["contact", "profile"],
});
console.log(page.data.length, page.nextCursor);

for await (const thread of inbox.threads.list.items({ folder: "all", limit: 100 })) {
  console.log(thread.id, thread.contact?.notes);
}

try {
  const sent = await inbox.messages.send({
    target: { type: "thread", threadId: page.data[0]!.id },
    content: "Thanks for reaching out.",
    idempotencyKey: "order-4821-followup",
  });
  console.log(sent.message.id, sent.httpStatus === 200 ? "replayed" : "sent");
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
