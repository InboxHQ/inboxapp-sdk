---
"@inboxapp/sdk": minor
---

Update to the latest Inboxapp API v2 spec.

- `people.search` reports its per-account-link limit as `platformRateLimited` instead of `peopleSearchRateLimited`. `PeopleSearchRateLimited` is removed from the error types and the Effect schemas.
- `platformRateLimited` details add optional `window`, `limit` and `resetAt`, present when Inboxapp's own limit on calls to the platform was reached rather than the platform's.
