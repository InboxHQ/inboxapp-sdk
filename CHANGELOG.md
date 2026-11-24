# @inboxapp/sdk

## 0.4.0

### Minor Changes

- 46bd47f: Update to the latest Inboxapp API v2 spec.
  
  - `views.list` (`GET /views`) lists the team's system and saved views.
  - `threads.search` (`GET /threads/search`) and `threads.count` (`GET /threads/count`) search and count threads.
  - `threads.list` takes `view`, `unread`, `awaitingReply` and `includeArchived`.
  - New error codes: `memberRequired`, `viewNotFound` and `searchUnavailable`. `searchUnavailable` is retried as transient.
  - `messages.send` can send rich messages through `rich` (polls, events, contacts, locations), so `content` is now optional. It also takes `route` and `subject`.
  - Messages have a `rich` field. Threads have `readReceipts`, which `threads.update` can set.
  - WhatsApp and Telegram platform data on profiles and messages, `phones` on contacts, and the `notArchived` attachment media status.

## 0.3.0

### Minor Changes

- abfe491: Update to the latest Inboxapp API v2 spec.
  
  - `people.search` reports its per-account-link limit as `platformRateLimited` instead of `peopleSearchRateLimited`. `PeopleSearchRateLimited` is removed from the error types and the Effect schemas.
  - `platformRateLimited` details add optional `window`, `limit` and `resetAt`, present when Inboxapp's own limit on calls to the platform was reached rather than the platform's.

## 0.2.0

### Minor Changes

- d51e686: Update to the latest Inboxapp API v2 spec.
  
  - `people.search` (`GET /people`) searches people on each platform through the team's account links.
  - `relationships.connect` (`POST /connection-requests`) sends a connection request.
  - New webhook events: `connectionRequest.sent`, `connectionRequest.accepted`, `connectionRequest.withdrawn`, `follower.created` and `message.seen`.
  - A `profile` send target can name the person by `username` as well as `platformId`.
  
  Some generated type names now follow the spec's variant titles: `SendRequestTargetProfile` splits into `SendRequestTargetProfileByPlatformID` and `SendRequestTargetProfileByUsername`, and `MessageSentByApi` is now `MessageSentByAPIToken`. The same renames apply to the Effect schemas.

## 0.1.1

### Patch Changes

- 82c79dc: First trusted published version
