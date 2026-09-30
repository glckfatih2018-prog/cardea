# Run Cardea on Stellar testnet

This release is a **single-organization, self-hosted application**, with a separate API and persistent reconciliation worker. The website serves `/` (introduction), `/app` (operator), `/onboard/:invitation` (recipient), and `/docs/` (public documentation).

## Local setup

Requirements: Node.js 24 LTS, npm, and PostgreSQL 17. Docker is optional, only for starting a local database. Never use an existing mainnet key in this project.

```sh
git clone https://github.com/glckfatih2018-prog/cardea.git
cd cardea
npm ci
npm run init:local
docker compose up -d db
npm run setup:testnet
npm run build
export CARDEA_CONFIG="$PWD/.local/config.json"
npm start
```

In a second terminal, from the same directory:

```sh
export CARDEA_CONFIG="$PWD/.local/config.json"
npm run worker
```

Open http://localhost:4317. The generated operator password is in `.local/operator-password`. It is not a wallet key. Open that file locally to sign in; do not paste it into public issue reports. The API alone cannot onboard: the worker and a coherent reserve sample must both be fresh (under 90 seconds).

If using native PostgreSQL instead of Docker, create an isolated database/user named `cardea`, listening on loopback port 55433, with the password in `.local/pg-password`. Do not overwrite or reinitialize an existing database. Alternatively supply `CARDEA_DATABASE_URL` to `setup:testnet` before it creates the configuration. Tests use `TEST_DATABASE_URL` when set; otherwise they read the local configuration. Tests create isolated namespaces, then delete only their own test records.

`setup:testnet` generates **test fixture** keys for the institution and a treasury, funds them using Friendbot, and creates two sponsors, a fee payer and ten channels. The application itself never generates recipient wallets. Running setup again reuses its private files; it never overwrites the configuration. Friendbot/network availability can delay setup; retry with the same files. Keep `.local/` private and out of Git.

## Configuration and responsibility

`CARDEA_CONFIG` must name a JSON file with mode 0600. The setup creates it. It contains PostgreSQL connection credentials, an scrypt operator password hash, institution signing keys and their public roles. Sponsor, channel and fee-payer roles must be distinct. All configured role keys must match. `network` must be exactly one of the two known passphrases; each resolves to a fixed profile (Horizon URL, USDC issuer, explorer) that cannot be overridden. Testnet is `Test SDF Network ; September 2015`. The public network additionally requires the acknowledgement, ceilings, namespace, HTTPS, relay and remote-signer rules in [MAINNET.md](MAINNET.md); there is no runtime toggle and persisted state is bound to one network at first start. Optional `reserveCeiling` (total XLM across pools) and `signerLimits` (`count`, `fee` XLM per UTC day, read by the signer from its own file) may also be set on testnet.

Public pool settings are created in the UI: name, sponsor, maximum committed reserve and daily fee budget. Fee budgets use UTC calendar days. The fee payer is separate from the reserve sponsors. A recipient costs three reserve units (currently 1.5 test XLM); the worker reads the network base reserve instead of assuming it will remain constant.

The default server listens on 127.0.0.1:4317. For a remote self-hosted installation, use a TLS reverse proxy with an exact HTTPS `origin` in the private config. Do not publish PostgreSQL or signer files. `trustProxy` remains disabled. Hosted deployments must enable the authenticated relay described below; plain reverse-proxy mode otherwise shares the proxy IP budget. Never trust arbitrary forwarded headers.

Templates in `deployment/` show separate API and worker systemd units for Linux. Create an unprivileged `cardea` service user, put code in `/opt/cardea`, secrets in `/etc/cardea/config.json` owned by that user (0600), and configure a local database. Adjust the npm executable path to the host's Node installation. The September 14 deployment runs the API and worker as separate unprivileged systemd services on Linux, with PostgreSQL 17 in a dedicated Docker container bound to loopback. The existing database, namespace and signers were migrated together after stopping both local services.

## Pool workflow

1. Create a paused pool and fund the chosen testnet sponsor and fee payer. The UI provides the public sponsor address and Friendbot link.
2. Upload recipient public addresses as plain text or a headerless CSV, one address per cell. The UI imports at most 30 KB per file; the API accepts 500 addresses per batch, 5,000 unique addresses per pool. No private keys.
3. Activate the pool. Activation checks the worker, balances and expected sponsor counters.
4. Select each allowed recipient and share that recipient’s individual invitation. Links are cryptographically bound to the selected public address. The invitation alone cannot authorize a sponsorship: the address must be allowed and its exact prepared transaction signed by its wallet.
5. Follow pending, confirmed and rejected transactions, reserves, and explorer links in the dashboard.
6. Pause to block new preparations and co-signing. **Already signed transactions remain valid until ledger expiry** and continue reconciliation; pausing cannot revoke a blockchain signature.
7. The worker automatically releases sponsorship after the recipient can cover its reserve including native selling liabilities. A recipient at zero XLM remains sponsored. After a definitive failed graduation, that recipient enters a 24-hour cooldown measured from the failed intent’s creation; the worker retries after that interval if still eligible. This prevents repeated balance changes from continuously consuming the shared fee budget. Existing signed envelopes still reconcile.
8. For handover, choose another configured institutional sponsor and request transfer. Both institutions' keys authorize it; the recipient never signs that maintenance transaction.

Pools are accounting groups, not independent on-chain vaults. Multiple pools can use the same sponsor; physical capacity is reserved across them. A sponsor must be dedicated to this installation: signing unrelated sponsorships outside Cardea will trigger the mismatch monitor. Institution signers and the database belong to the same trusted operator; namespace is a test/isolation convenience, not SaaS tenant isolation.

## Durability and recovery

State is stored in PostgreSQL as one locked JSONB aggregate per installation, with transactional audit events. This deliberately serializes allocations and avoids cross-pool races; it is intended for the scoped small institutional workload, not high-volume multi-tenancy. An advisory lock allows only one reconciliation worker to execute at a time. HTTP response loss never causes a newly signed transaction to be created automatically.

- `AWAITING_SIGNATURE`: immutable body and short-lived reservation; no sponsor signature yet.
- `READY`: all signatures and transaction hash durably stored before submission.
- `UNKNOWN`: submission may have reached the network. Keep the reservation and channel; reconcile by hash.
- `CONFIRMED`/`FAILED`: authoritative ledger result, including actual charged fee, recorded once.
- `EXPIRED`: ledger time is past expiry and, for a signed envelope, the channel sequence proves it was not consumed.

Restart API/worker with the **same database, namespace and keys**. Never delete pending rows to clear a queue. If sequence consumption has no matching transaction history, the installation halts instead of guessing. Inspect the channel and archived transaction on Horizon before making any repair. Do not change a channel key or namespace while signatures are outstanding.

The worker stops new work on a detected testnet ledger regression. A testnet reset can remove accounts and history: save evidence first, stop services, archive the old database/config, and intentionally create a fresh installation with newly funded test keys and a fresh namespace. Never silently reconnect old pending intents to a reset chain.

Back up PostgreSQL and institution configuration together, encrypt backups, and restrict restore access. Restore first into an isolated environment; compare pending transaction hashes and sponsor counts against testnet before enabling traffic. `/api/health` returns 503 if the worker or coherent reserve sample is stale, or the installation halted. No uptime or automatic recovery guarantee is implied by a 200 response.

## Tests

```sh
npm run build
npm test
npm run security
# Explicit network test, using isolated test keys only:
CARDEA_CONFIG="$PWD/.local/config.json" npm run test:testnet
```

Run network acceptance on an isolated installation with the background worker stopped; the harness drives reconciliation itself. Never point it at another operator's configuration. The harness signs recipient test fixtures, **not Freighter**. Real-wallet UI validation is recorded separately in the evidence index. Testnet uses valueless assets, and its history may be reset; archived account snapshots and transaction results accompany the explorer hashes.

## Hosted testnet deployment

The live landing page is https://cardea-site.vercel.app; the operator application is `/app` and documentation is `/docs/`. On September 14, the owner confirmed their verified Git email, resolving the initial commit-author attribution block. Deployment `dpl_FQPjz7V5dNsgrbH93JF1hZMeuKUu` was promoted successfully. Vercel serves static assets and proxies `/api/*` over HTTPS to the dedicated Cardea API on the VPS. The worker runs continuously on that VPS. The configured allowed origin is the stable Vercel URL; preview URLs are not alternate operator origins.

No institution signing keys, database backups or local wallet files are uploaded to Vercel. Private runtime configuration resides in `/etc/cardea/config.json` (0600); PostgreSQL listens only on loopback port 55433. Keep the Mac API/worker stopped after migration to avoid two independent installations using the same signers. Vercel deployment protection settings are preserved.

## Languages and entry routes

`/app` now separates recipients (personal invitation) from organizations. The existing installation password is used only at `/organization`; no public signup or multi-organization custody service was introduced. `/docs/` is a localized, section-based reader with a persistent left navigation and shareable section hashes.

English, Turkish, German, French and Spanish are bundled with the app. An explicit selection stored in `cardea-language` wins over automatic detection. Otherwise the Vercel-only `/api/locale` function maps the platform's IP-country header to a language; unknown, unsupported or unavailable country data falls back to English. It stores no IP and returns `private, no-store`. Turkish maps to TR; German to DE/AT/LI; French to FR/MC; Spanish to ES and the Spanish-speaking countries enumerated in `api/locale.js`. Other countries, including multilingual countries without a chosen mapping, use English. The frontend has a bounded timeout and a validated English fallback. Existing invitation tokens, addresses, XDR, authorization headers and transaction semantics are unchanged.

## Hardened gateway and signer deployment

Use the three systemd units in `deployment/`. Create a `cardea-signer` user and a `cardea-sign` socket-access group; add only the API/worker user to that group. Root must own `/opt/cardea` and its dependencies so the API cannot change signer code. Store private signer config at `/etc/cardea-signer/config.json`, mode 0600 owned by `cardea-signer`, with a 0700 parent. Keep the signer journal at `/var/lib/cardea-signer/journal.json`; back it up with the database. Never run two signer processes over one journal.

These paths and units belong to the existing **testnet** installation. A mainnet pilot must use the separate units and paths in [`deployment/mainnet/`](../deployment/mainnet/) and the [mainnet runbook](MAINNET.md); do not replace the testnet service files or database.

API/worker `/etc/cardea/config.json` uses `keys: []` and `signerSocket: "/run/cardea-signer/sign.sock"`. It must not contain private signing keys. The constrained signer config keeps the original role keys, with no `signerSocket`. It does not need database credentials. The local developer setup retains in-process signing; separate-user isolation is a property of the hardened deployment, not a claim about local fixtures.

Set matching random secrets (at least 32 characters) in backend `relaySecret` and Vercel `CARDEA_RELAY_SECRET`. Set Vercel `CARDEA_API_ORIGIN` to the dedicated HTTPS API origin. `api/relay.js` receives the explicit internal `/api/:path*` rewrite and replaces the external proxy rewrite. It uses Vercel's protected `x-vercel-forwarded-for` header and does not trust visitor-supplied forwarding headers. Backend requests without a fresh valid attestation are denied, including direct public requests. Use the stable website `/api/health` for external checks. Do not enable the backend gate until the relay deployment is ready.

The signer applies an additional conservative installation-wide ceiling of 100 distinct signed transactions and 1 XLM worst-case fees per UTC day, independent of editable pool limits. Identical retries do not consume it twice. This also includes maintenance; reaching it delays new signatures until the next UTC day, while already signed transactions continue reconciliation. These are testnet defaults. Policy-shaped abuse following an API/database compromise is bounded, not eliminated; the signer prevents arbitrary transfer/authority operations but does not independently authenticate organization admins or their allowlists.

Horizon reads no longer hold row locks. If another state mutation occurs while observations are fetched, the operation retries with fresh state, up to a bounded retry count. Keep capacity and concurrency regression tests when changing this behavior.
