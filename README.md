# Cardea

**Open a Stellar account without asking the recipient to buy XLM first.**

Cardea is a self-hosted, open-source Stellar application. It runs on **testnet** by default; the Stellar public network is available only through an explicit, fail-closed configuration described in [Mainnet readiness](docs/MAINNET.md). A limited mainnet pilot is live at [cardea.website](https://cardea.website); it has completed real recipient onboarding, but has not received an independent security audit. An institution chooses eligible recipients, sponsors their account and USDC trustline reserves, and pays the transaction fee. Each recipient connects their own Freighter wallet and signs one fixed onboarding transaction. Their wallet remains theirs.

The reserve is locked in the sponsor's balance, not transferred to the recipient. At a 0.5-XLM base reserve, one account plus a USDC trustline requires three units: 1.5 XLM. Cardea reads the network reserve value. When recipients can cover their own reserve, the worker automatically releases sponsorship; another configured sponsor can also take it over without another recipient signature.

## What is implemented

- CAP-33 sponsored account creation and USDC trustline, wrapped in a CAP-15 fee-bump.
- Strict signed-body comparison and recipient-signature validation before institution co-signing.
- PostgreSQL reservations, channel leases, durable submission outbox, replay-safe reconciliation and audit events.
- Public and private operator pools, address allowlists, recipient-bound invitation links, reserve/fee limits and pause controls.
- Continuous sponsor-counter monitoring, automatic graduation and sponsor handover.
- A dedicated landing page `/`, operator workspace `/app`, recipient directory `/receive`, recipient invitation page `/onboard/:token`, and documentation `/docs/`.
- Automated application/security tests and archived real testnet and limited mainnet acceptance evidence.

This is an application delivery with archived testnet and mainnet pilot evidence, **not a custody product or independent security certification**. It does not send payroll, distribute USDC, generate recipient wallets, deploy Soroban contracts or provide multi-tenant SaaS. Mainnet operation requires the acknowledgement, explicit budgets, dedicated namespace, remote signer and HTTPS relay described in [docs/MAINNET.md](docs/MAINNET.md).

## Start locally

Node.js 24 LTS and PostgreSQL 17 are required. Docker is optional for the database.

```sh
npm ci
npm run init:local
docker compose up -d db
npm run setup:testnet
npm run build
export CARDEA_CONFIG="$PWD/.local/config.json"
npm start
```

In another terminal, start `npm run worker` with the same `CARDEA_CONFIG`. Open **http://localhost:4317** and use the private password in `.local/operator-password`. No private key belongs in the browser or GitHub.

For native PostgreSQL, alternate database URLs, Linux service templates, TLS, permissions and recovery, see **[Operations](docs/OPERATIONS.md)**. Run from the repository root. Keep a dedicated testnet installation; do not share its signer accounts with another namespace or application.

## Verify

```sh
npm run build
npm test
npm run security
# Explicit live testnet acceptance (stop the background worker for this harness):
CARDEA_CONFIG="$PWD/.local/config.json" npm run test:testnet
```

The application/security tests use real PostgreSQL with isolated namespaces and a fake ledger for controlled faults. The live harness uses Stellar testnet and archives transaction hashes, returned XDR and account snapshots. Its generated recipient keypairs are test fixtures; they are not evidence of a Freighter click-through. The separate wallet acceptance record identifies what was actually observed.

See **[Evidence and release status](docs/evidence/README.md)** for executed checks, reproduction commands, transaction links and remaining limitations. The original [planning matrix](docs/planning/TEST-MATRIX.md) records proposed acceptance cases, not automatically passing tests.

## How it works

```text
Operator → recipient allowlist + recipient-bound invitation
Recipient wallet → one signature over the saved onboarding transaction
API → verify exact signing payload and recipient signature
    → institution signatures + fee-bump → PostgreSQL durable outbox
Worker → submit/reconcile by hash → confirmed account and USDC trustline
       → monitor reserves → graduate or transfer sponsorship
```

The inner transaction contains `BeginSponsoringFutureReserves`, `CreateAccount` with zero starting balance, `ChangeTrust` for the profile's fixed USDC issuer, and `EndSponsoringFutureReserves`. The server compares the **signature payload**, not the whole signed envelope (the signature necessarily changes the envelope), then validates the signature separately.

Pausing blocks new requests and co-signing. It cannot revoke a signature already issued to the network. Unknown submission outcomes retain their channel and reserve until reconciled. The sponsor, fee payer and channel keys are institution-owned and loaded from a private configuration file; the recipient key stays in Freighter.

## Documentation

- [Operations, setup and recovery](docs/OPERATIONS.md)
- [Mainnet readiness and checklist](docs/MAINNET.md)
- [API integration](docs/API.md)
- [Security model and audit results](SECURITY.md)
- [Evidence index](docs/evidence/README.md)
- [Requirements and research](docs/planning/README.md)
- [Contribution guide](CONTRIBUTING.md)

The root JavaScript files (`spike.js`, `negative.js`, `graduate.js`, `handover.js`, `xlm-arrival.js`) are historical protocol experiments. They are not the application, are not run by npm test, and are not the release acceptance harness. Use the TypeScript application and scripts above.

References: Stellar [sponsored reserves](https://developers.stellar.org/docs/build/guides/transactions/sponsored-reserves), [fee-bump transactions](https://developers.stellar.org/docs/build/guides/transactions/fee-bump-transactions), [channel accounts](https://developers.stellar.org/docs/build/guides/transactions/channel-accounts), and [Freighter](https://docs.freighter.app/docs/playground/signtransaction/).

MIT licensed. The mainnet pilot was developed in **Foreveranka/cardea** and is delivered in this repository.
