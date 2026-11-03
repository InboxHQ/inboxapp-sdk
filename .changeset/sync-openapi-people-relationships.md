---
"@inboxapp/sdk": minor
---

Update to the latest Inboxapp API v2 spec.

- `people.search` (`GET /people`) searches people on each platform through the team's account links.
- `relationships.connect` (`POST /connection-requests`) sends a connection request.
- New webhook events: `connectionRequest.sent`, `connectionRequest.accepted`, `connectionRequest.withdrawn`, `follower.created` and `message.seen`.
- A `profile` send target can name the person by `username` as well as `platformId`.

Some generated type names now follow the spec's variant titles: `SendRequestTargetProfile` splits into `SendRequestTargetProfileByPlatformID` and `SendRequestTargetProfileByUsername`, and `MessageSentByApi` is now `MessageSentByAPIToken`. The same renames apply to the Effect schemas.
