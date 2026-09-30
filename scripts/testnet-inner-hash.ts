/** One-off real-testnet check of Horizon fee-bump inner-hash lookup semantics. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  Account, Asset, Keypair, Operation, TransactionBuilder,
} from "@stellar/stellar-sdk";
import { loadConfig, networkOf } from "../src/config.ts";
import { TestnetChain, NETWORK, hex } from "../src/stellar.ts";
import { recordWallets } from "./wallet-ledger.ts";

if (networkOf(loadConfig()).name !== "testnet")
  throw new Error("Real-testnet check refuses a non-testnet configuration");
const keyFile = ".local/inner-hash-payer.json";
const setup = JSON.parse(readFileSync(".local/setup-keys.json", "utf8"));
const source = Keypair.fromSecret(setup.treasury);
const payer = existsSync(keyFile)
  ? Keypair.fromSecret(JSON.parse(readFileSync(keyFile, "utf8")).payer)
  : Keypair.random();
if (!existsSync(keyFile))
  writeFileSync(keyFile, JSON.stringify({ payer: payer.secret() }), { mode: 0o600 });
recordWallets([{ role: "inner-hash test fee payer", publicKey: payer.publicKey() }], keyFile);
const chain = new TestnetChain();
let account = await chain.account(source.publicKey());
assert.ok(account, "Isolated treasury missing");
if (!(await chain.account(payer.publicKey()))) {
  const funding = new TransactionBuilder(new Account(account.account_id, account.sequence), {
    fee: "1000", networkPassphrase: NETWORK,
  }).addOperation(Operation.createAccount({
    destination: payer.publicKey(), startingBalance: "5",
  })).setTimeout(180).build();
  funding.sign(source);
  await chain.submit(funding.toXdr());
  assert.ok(await chain.account(payer.publicKey()), "Testnet payer funding failed");
  account = await chain.account(source.publicKey());
  assert.ok(account);
}
const inner = new TransactionBuilder(new Account(account.account_id, account.sequence), {
  fee: "100", networkPassphrase: NETWORK,
})
  .addOperation(Operation.payment({
    destination: source.publicKey(), asset: Asset.native(), amount: "0.0000001",
  }))
  .setTimeout(180)
  .build();
inner.sign(source);
const ownWrapper = TransactionBuilder.buildFeeBumpTransaction(
  source, "1000", inner, NETWORK,
);
ownWrapper.sign(source);
const replacement = TransactionBuilder.buildFeeBumpTransaction(
  payer, "2000", ownWrapper.innerTransaction, NETWORK,
);
replacement.sign(payer);
const innerHash = hex(inner.hash()), outerHash = hex(replacement.hash());
assert.notEqual(hex(ownWrapper.hash()), outerHash);
try {
  await chain.submit(replacement.toXdr());
} catch {
  // Horizon submission errors are ambiguous; poll the immutable hash.
}
let outer = null, byInner = null;
for (let n = 0; n < 15; n++) {
  outer = await chain.result(outerHash);
  byInner = await chain.result(innerHash);
  if (outer && byInner) break;
  await new Promise((r) => setTimeout(r, 4000));
}
assert.ok(outer?.successful, "Foreign fee-bump did not land");
assert.ok(byInner, "Horizon did not resolve a fee bump by inner hash");
assert.equal(byInner.hash, innerHash);
assert.equal(byInner.inner_transaction?.hash, innerHash);
assert.equal(byInner.fee_bump_transaction?.hash, outerHash);
assert.equal(byInner.fee_account, payer.publicKey());
assert.equal(byInner.envelope_xdr, replacement.toXdr());
const evidence = {
  network: NETWORK,
  observedAt: new Date().toISOString(),
  innerHash, outerHash,
  outerResultHash: outer.hash,
  innerLookupHash: byInner.hash,
  feeAccount: byInner.fee_account,
  ledger: byInner.ledger,
  checks: [
    "foreign fee bump landed",
    "same signed inner has distinct outer hash",
    "Horizon lookup by inner hash resolves the landed envelope",
    "Horizon response identifies foreign fee account and outer hash",
  ],
};
const path = `docs/evidence/testnet-inner-hash-${Date.now()}.json`;
writeFileSync(path, JSON.stringify(evidence, null, 2));
console.log("PASS real testnet inner-hash lookup", path);
