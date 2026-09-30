# Cardea API

Base path `/api`, same origin as the application. JSON mutation requests require the exact configured `Origin`. Requests are limited to 32 KB. Unknown JSON fields are rejected. Generic dependency failures return 503 without credentials or raw transaction data. Inspect request status before retrying a submission.

## Operator session

`POST /admin/login` body `{ "password": "operator password" }` sets an HttpOnly, SameSite=Strict session cookie, Secure on HTTPS, expiring after eight hours, and returns `{ "csrf": "..." }`. The password is compared to a salted scrypt hash. Login is rate-limited to five per minute per client IP.

All other `/admin/*` endpoints require this cookie. Mutations additionally require `x-csrf-token` from the login/session response. `GET /admin/session` resumes the CSRF token for that cookie. `POST /admin/logout` invalidates the session.

| Method/path | Body / result |
| --- | --- |
| GET `/admin/dashboard` | Pools, allowlists, committed/pending reserves, transaction status, recent audit events; no keys or signed envelopes |
| POST `/admin/pools` | `name`, configured `sponsor` public address, `cap` and `feeCap` as decimal XLM strings; optional `description` (up to 1,000 characters), `participantLimit` (integer 1–100,000 or null; default 50) |
| POST `/admin/pools/:id/profile` | `name` (1–80 characters), `description` (up to 1,000 characters), `participantLimit` (integer 1–100,000 or null); limit cannot fall below confirmed plus pending participation |
| POST `/admin/pools/:id/allowlist` | `addresses`: public-address array; optional `remove`: boolean |
| POST `/admin/pools/:id/limits` | `cap`, `feeCap`: decimal XLM; cannot reduce below committed/pending reserve or paid/pending fees |
| POST `/admin/pools/:id/policy` | `active`: boolean |
| POST `/admin/pools/:id/invite` | `{}`; rotates invitation; outstanding prepared requests retain their independent request token |
| POST `/admin/pools/:id/handover` | `recipient`, configured `target` sponsor; returns pending maintenance intent |

## Recipient

`GET /onboarding/directory` lists public and private pools, including paused/full pools. `GET /onboarding/directory/:id` returns one pool or 404. Fields: `id`, `name`, `description`, `access`, `participants`, `pendingParticipants`, `participantLimit` (null for no set limit), `availability` (`open`, `full`, `reserved`, `paused`, `unavailable`). Responses are uncacheable and contain no recipient identities, invitation links or private operational state. Directory visibility does not authorize admission to private pools. These counts represent distinct wallets; completed participants remain counted after sponsorship release.

`GET /onboarding/network` returns the installation's immutable network profile: `name` (`testnet` or `mainnet`), `passphrase`, `horizon`, `issuer`, `explorer` and `friendbot` (null on mainnet). It is uncacheable and contains no keys, balances, limits or operational state. Clients must sign only for the returned passphrase and must treat a missing or unknown profile as a hard stop. `GET /health` reports the same `network` name.

The legacy `GET /onboarding/pools` still returns active public pool names and IDs only. Public admission uses `{ "pool": "pool UUID", "recipient": "G..." }` instead of `invite` at preparation. Both routes accept an uncreated account or an existing account without a USDC trustline. Participant capacity includes pending onboardings and is reserved atomically.

1. `POST /onboarding/prepare`: `{ "invite": "invitation token", "recipient": "G..." }` → `id`, `token`, unsigned `xdr`, `expires` (Unix seconds), `network` passphrase. Use the recipient-bound token from the dashboard’s `links` array, not the pool’s internal invitation seed. A token for one allowed address cannot prepare another. The private invitation route requires an allowlisted address. Unsigned preparation is limited to three attempts per recipient per UTC day; only a verified signature consumes the pool-wide signed-admission limit. Keep the request token private to the recipient session.
2. Have the recipient wallet sign that exact inner transaction for the `network` passphrase returned by prepare (which always equals `GET /onboarding/network`). Do not modify fee, sources, memo, operations, sequence or time bounds. Exactly one valid recipient signature is accepted; a signature produced for another network is rejected.
3. `POST /onboarding/:id/submit`: `{ "token": "request token", "xdr": "recipient-signed XDR" }` → public intent. Server validates the complete signing body and signature, signs the original trusted body, wraps the fee bump, and persists it before network submission.
4. `GET /onboarding/:id/status` with `Authorization: Bearer <request token>` → same public intent. Confirm success only when `state` is `CONFIRMED`. A status ID alone grants no access. Retry the same ID/token after connection loss; do not create a second request while one is pending.

Public intent fields: `id`, `recipient`, `kind`, `state`, optional `hash`, `ledger`, `fee` (stroops), `reason`, `expires`. A duplicate submit with the valid request token returns the existing state and does not sign or bill again.

Authentication errors use 401/403, unknown request tokens 404, policy/capacity conflicts 409, rate limits 429. Modified transaction/signature returns 400. Network and database errors may be ambiguous; retry status first.

There is no recipient-key endpoint, arbitrary transaction signing, arbitrary Horizon URL, payment endpoint, runtime network switch, or public graduation trigger. Maintenance is deterministic worker/operator behavior.
