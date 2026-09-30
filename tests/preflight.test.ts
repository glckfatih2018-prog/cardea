import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { assessRoleAccount, assessRoleLedger, assessSponsorFunding, assessState } from "../src/preflight.ts";
import { initial, type Intent, type State } from "../src/model.ts";
import type { ChainAccount } from "../src/stellar.ts";

const now = Math.floor(Date.now() / 1000);
const network = "Public Global Stellar Network ; September 2015";
const reserve = 5000000n;
const by = (checks: ReturnType<typeof assessState>, name: string) =>
  checks.find((c) => c.name === name)?.ok;

test("preflight refuses missing, stale, halted and signed-pending state", () => {
  assert.equal(by(assessState(undefined, network, reserve, "10", now), "state.initialized"), false);
  const s = initial(network);
  s.workerAt = now;
  s.monitorAt = now;
  s.snapshot = { ledger: 1, closedAt: now, reserve: String(reserve), baseFee: 100 };
  assert.ok(assessState(s, network, reserve, "10", now).every((c) => c.ok));
  s.monitorAt = now - 91;
  assert.equal(by(assessState(s, network, reserve, "10", now), "state.monitor"), false);
  s.monitorAt = now;
  s.haltReason = "counter mismatch";
  assert.equal(by(assessState(s, network, reserve, "10", now), "state.halted"), false);
  s.haltReason = undefined;
  s.intents.push({state:"UNKNOWN",kind:"onboard",cost:"5000000"} as Intent);
  assert.equal(by(assessState(s, network, reserve, "10", now), "state.signedPending"), false);
});

test("mainnet preflight refuses a sponsor shared by two pools", () => {
  const s = initial(network);
  const sponsor = Keypair.random().publicKey();
  s.pools.push({ id: "one", sponsor, sponsorships: [] } as unknown as State["pools"][number]);
  s.pools.push({ id: "two", sponsor, sponsorships: [] } as unknown as State["pools"][number]);
  assert.equal(by(assessState(s, network, reserve, "10", now), "state.sponsorIsolation"), false);
});

test("preflight counts onboarding reserve once and requires role signing weight", () => {
  const s = initial(network);
  s.workerAt = s.monitorAt = now;
  s.snapshot = { ledger: 1, closedAt: now, reserve: String(reserve), baseFee: 100 };
  s.intents.push({state:"AWAITING_SIGNATURE",kind:"onboard",cost:"15000000"} as Intent);
  assert.equal(by(assessState(s, network, reserve, "1", now), "state.reserveCeiling"), false);
  assert.equal(by(assessState(s, network, reserve, "2", now), "state.reserveCeiling"), true);

  const key = Keypair.random().publicKey();
  const acc: ChainAccount = {
    account_id:key, sequence:"1", num_sponsoring:0, num_sponsored:0,
    subentry_count:0, balances:[{asset_type:"native", balance:"10"}],
    signers:[{key,weight:1}], thresholds:{med_threshold:2},
  };
  const checks = assessRoleAccount("sponsor", key, acc, reserve, 0n, 1);
  assert.equal(checks.find((c) => c.name.endsWith(".signer"))?.ok, false);
  assert.equal(checks.find((c) => c.name.endsWith(".sponsoring"))?.ok, false);
  acc.thresholds!.med_threshold = 1;
  acc.num_sponsoring = 1;
  assert.ok(assessRoleAccount("sponsor", key, acc, reserve, 0n, 1).every((c) => c.ok));
  acc.signers.push({ key: Keypair.random().publicKey(), weight: 1 });
  assert.equal(by(assessRoleAccount("sponsor", key, acc, reserve, 0n, 1),
    `account.sponsor.${key}.exclusiveSigner`), false);
  acc.signers[1].weight = 0;
  assert.equal(by(assessRoleAccount("sponsor", key, acc, reserve, 0n, 1),
    `account.sponsor.${key}.exclusiveSigner`), true);
  delete acc.thresholds;
  assert.equal(assessRoleAccount("sponsor", key, acc, reserve, 0n, 1)[0]?.ok, false);
});

test("mainnet preflight requires funded sponsor capacity for the configured reserve ceiling", () => {
  const key = Keypair.random().publicKey();
  const sponsor: ChainAccount = {
    account_id: key, sequence: "1", num_sponsoring: 0, num_sponsored: 0,
    subentry_count: 0, balances: [{ asset_type: "native", balance: "2" }],
    signers: [{ key, weight: 1 }], thresholds: { med_threshold: 1 },
  };
  const state = initial(network);
  // With a 1 XLM account minimum, the sponsor has only 1 XLM liquid.
  assert.equal(assessSponsorFunding([sponsor], 1, state, reserve, "2").ok, false);
  assert.equal(assessSponsorFunding([sponsor], 1, state, reserve, "1").ok, true);
  assert.equal(assessSponsorFunding([], 1, state, reserve, "1").ok, false);
  assert.equal(assessSponsorFunding([sponsor], 1, undefined, reserve, "1").ok, false);
  state.pools.push({ sponsorships: [{ units: 3 }] } as State["pools"][number]);
  sponsor.num_sponsoring = 3;
  sponsor.balances[0]!.balance = "3.5";
  // The already locked 1.5 XLM counts once; 1 XLM remains liquid.
  assert.equal(assessSponsorFunding([sponsor], 1, state, reserve, "2.5").ok, true);
  assert.equal(assessSponsorFunding([sponsor], 1, state, reserve, "3").ok, false);
});

test("mainnet preflight refuses role data from an older or untagged ledger", () => {
  const key = Keypair.random().publicKey();
  assert.equal(assessRoleLedger("channel", key, 99, 100).ok, false);
  assert.equal(assessRoleLedger("channel", key, null, 100).ok, false);
  assert.equal(assessRoleLedger("channel", key, 100, 100).ok, true);
  assert.equal(assessRoleLedger("channel", key, 101, 100).ok, true);
});
