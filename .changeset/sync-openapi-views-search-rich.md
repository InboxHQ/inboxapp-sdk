---
"@inboxapp/sdk": minor
---

Update to the latest Inboxapp API v2 spec.

- `views.list` (`GET /views`) lists the team's system and saved views.
- `threads.search` (`GET /threads/search`) and `threads.count` (`GET /threads/count`) search and count threads.
- `threads.list` takes `view`, `unread`, `awaitingReply` and `includeArchived`.
- New error codes: `memberRequired`, `viewNotFound` and `searchUnavailable`. `searchUnavailable` is retried as transient.
- `messages.send` can send rich messages through `rich` (polls, events, contacts, locations), so `content` is now optional. It also takes `route` and `subject`.
- Messages have a `rich` field. Threads have `readReceipts`, which `threads.update` can set.
- WhatsApp and Telegram platform data on profiles and messages, `phones` on contacts, and the `notArchived` attachment media status.
