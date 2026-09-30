import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import {
  Keypair,
  Account,
  TransactionBuilder,
  Operation,
  Asset,
} from "@stellar/stellar-sdk";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import {
  TestnetChain,
  NETWORK,
  hex,
  sponsored,
  native,
} from "../src/stellar.ts";
import { resolveNetwork } from "../src/network.ts";
// Requires the real background worker. This test intentionally never calls Cardea.tick or maintenance.
const config = loadConfig();
// Testnet-only: this harness pays a fixture recipient from the local treasury.
if (resolveNetwork(config.network).name !== "testnet")
  throw new Error("Testnet graduation harness refuses a non-testnet config");
const store = new Store(config.databaseUrl, config.namespace, NETWORK),
  chain = new TestnetChain();
await store.init();
try {
  const name = readdirSync("docs/evidence")
    .filter((n) => /^testnet-\d+\.json$/.test(n))
    .sort()
    .at(-1);
  if (!name) throw new Error("Run testnet acceptance first");
  const previous = JSON.parse(readFileSync("docs/evidence/" + name, "utf8"));
  const state = await store.read();
  const record = state.pools
    .flatMap((p) => p.sponsorships)
    .find(
      (r) =>
        r.units === 3 &&
        previous.accounts.some((a: any) => a.account_id === r.recipient) &&
        previous.transactions.some(
          (t: any) => t.recipient === r.recipient && t.kind === "onboard",
        ),
    );
  if (!record) throw new Error("No isolated sponsored fixture found");
  assert(config.autoGraduate);
  assert(Date.now() / 1000 - state.workerAt < 90);
  const before = await chain.account(record.recipient);
  assert(before);
  assert.equal(native(before).balance, "0.0000000");
  const sponsorBefore = await chain.account(record.sponsor);
  const keys = JSON.parse(readFileSync(".local/setup-keys.json", "utf8"));
  const treasury = Keypair.fromSecret(keys.treasury),
    t = await chain.account(treasury.publicKey());
  const tx = new TransactionBuilder(new Account(t!.account_id, t!.sequence), {
    fee: "1000",
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.payment({
        destination: record.recipient,
        asset: Asset.native(),
        amount: "2",
      }),
    )
    .setTimeout(180)
    .build();
  tx.sign(treasury);
  const startedAt = new Date().toISOString();
  await chain.submit(tx.toXdr());
  let intent;
  for (let n = 0; n < 40; n++) {
    const s = await store.read();
    intent = s.intents.find(
      (i) =>
        i.recipient === record.recipient &&
        i.kind === "graduate" &&
        i.state === "CONFIRMED",
    );
    if (intent) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  assert(intent, "Background worker did not graduate fixture");
  const after = await chain.account(record.recipient),
    sponsorAfter = await chain.account(record.sponsor);
  assert(after && sponsorAfter && sponsorBefore);
  assert.equal(sponsored(after, record.sponsor).units, 0);
  assert.equal(after.num_sponsored, 0);
  assert.equal(native(after).balance, "2.0000000");
  assert.equal(sponsorBefore.num_sponsoring - sponsorAfter.num_sponsoring, 3);
  assert.equal(after.signers.length, 1);
  assert.equal(after.signers[0].key, record.recipient);
  const evidence = {
    network: NETWORK,
    startedAt,
    finishedAt: new Date().toISOString(),
    mode: "Separate continuously running worker; harness never invokes tick or maintenance",
    checks: [
      "zero balance before",
      "automatic graduation by background worker",
      "recipient sponsored units 3 to 0",
      "sponsor counter minus 3",
      "sole signer unchanged",
      "recipient retains 2 test XLM",
    ],
    fundingHash: hex(tx.hash()),
    hash: intent.hash,
    result: await chain.result(intent.hash!),
    before,
    after,
    sponsorBefore,
    sponsorAfter,
  };
  const path = "docs/evidence/automatic-graduation-" + Date.now() + ".json";
  writeFileSync(path, JSON.stringify(evidence, null, 2));
  console.log("PASS automatic worker graduation", intent.hash, path);
} finally {
  await store.close();
}
