import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  Keypair,
  Transaction,
  TransactionBuilder,
  Account,
  Operation,
  Asset,
} from "@stellar/stellar-sdk";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { Cardea } from "../src/service.ts";
import {
  TestnetChain,
  NETWORK,
  ISSUER,
  native,
  sponsored,
  hex,
} from "../src/stellar.ts";
import { recordWallets } from "./wallet-ledger.ts";
import { resolveNetwork } from "../src/network.ts";
const config = { ...loadConfig(), autoGraduate: false };
// This harness signs fixture recipients and submits real transactions. It is
// testnet-only and refuses any other profile before touching the database or
// the network.
if (resolveNetwork(config.network).name !== "testnet")
  throw new Error("Testnet acceptance harness refuses a non-testnet config");
const store = new Store(config.databaseUrl, config.namespace, NETWORK);
await store.init();
const chain = new TestnetChain(),
  app = new Cardea(store, chain, config);
const run = Date.now().toString(),
  path = ".local/recipients-" + run + ".json";
const users = Array.from({ length: 50 }, () => Keypair.random());
writeFileSync(path, JSON.stringify(users.map((k) => k.secret())), {
  mode: 0o600,
});
recordWallets(
  users.map((u, i) => ({
    role: "acceptance recipient " + run + "/" + i,
    publicKey: u.publicKey(),
  })),
  path,
);
const evidence: any = {
  run,
  network: NETWORK,
  startedAt: new Date().toISOString(),
  checks: [],
  transactions: [],
};
async function check(label: string, fn: () => unknown | Promise<unknown>) {
  await fn();
  evidence.checks.push(label);
  console.log("PASS", label);
}
async function settled(ids: string[]) {
  for (let n = 0; n < 40; n++) {
    await app.tick();
    const s = await store.read();
    if (
      ids.every(
        (id) => s.intents.find((i) => i.id === id)?.state === "CONFIRMED",
      )
    )
      return;
    if (
      s.intents.some(
        (i) => ids.includes(i.id) && ["FAILED", "EXPIRED"].includes(i.state),
      )
    )
      throw new Error("Intent failed");
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Confirmation timeout");
}
try {
  await app.tick();
  const pool = await app.createPool(
    "Acceptance " + run,
    config.sponsors[0],
    "100",
    "1",
  );
  await app.allowlist(
    pool.id,
    users.map((u) => u.publicKey()),
  );
  await app.policy(pool.id, true);
  await check("50-address allowlist", async () =>
    assert.equal(
      (await store.read()).pools.find((p) => p.id === pool.id)!.allowlist
        .length,
      50,
    ),
  );
  await check("non-allowlisted rejected", () =>
    assert.rejects(() =>
      app.prepare(pool.invite, Keypair.random().publicKey()),
    ),
  );
  const payerBefore = await chain.account(config.feePayer),
    sponsorBefore = await chain.account(pool.sponsor);
  const prepared = await Promise.all(
    users
      .slice(0, 10)
      .map((u) =>
        app.prepare(app.invitation(pool, u.publicKey()), u.publicKey()),
      ),
  );
  await check("10 channels uniquely leased", async () => {
    const s = await store.read();
    assert.equal(
      new Set(
        s.intents
          .filter((i) => prepared.some((p) => p.id === i.id))
          .map((i) => i.channel + ":" + i.sequence),
      ).size,
      10,
    );
  });
  await check("duplicate pending rejected", () =>
    assert.rejects(() =>
      app.prepare(
        app.invitation(pool, users[0].publicKey()),
        users[0].publicKey(),
      ),
    ),
  );
  await Promise.all(
    prepared.map((p, n) => {
      const t = TransactionBuilder.fromXdr(p.xdr, NETWORK);
      t.sign(users[n]);
      return app.submit(p.id, p.token, t.toXdr());
    }),
  );
  await settled(prepared.map((p) => p.id));
  await check(
    "10 zero-XLM accounts + USDC + sole signer + sponsored reserve",
    async () => {
      for (const u of users.slice(0, 10)) {
        const a = await chain.account(u.publicKey());
        assert(a);
        assert.equal(native(a).balance, "0.0000000");
        assert.equal(a.signers.length, 1);
        assert.equal(a.signers[0].key, u.publicKey());
        assert.equal(a.num_sponsored, 3);
        assert.equal(sponsored(a, pool.sponsor).units, 3);
        assert(
          a.balances.some(
            (b) => b.asset_code === "USDC" && b.asset_issuer === ISSUER,
          ),
        );
      }
    },
  );
  const sponsorAfter = await chain.account(pool.sponsor),
    payerAfter = await chain.account(config.feePayer);
  await check("sponsor balance unchanged; 30 reserve units added", () => {
    assert.equal(native(sponsorBefore!).balance, native(sponsorAfter!).balance);
    assert.equal(
      sponsorAfter!.num_sponsoring - sponsorBefore!.num_sponsoring,
      30,
    );
  });
  const intents = (await store.read()).intents.filter((i) =>
    prepared.some((p) => p.id === i.id),
  );
  await check("fee payer paid only exact ledger fees", async () => {
    const { units } = await import("../src/stellar.ts");
    assert.equal(
      units(native(payerBefore!).balance) - units(native(payerAfter!).balance),
      intents.reduce((n, i) => n + BigInt(i.feeActual!), 0n),
    );
  });
  await check("replay returns same confirmed intent", async () => {
    const p = prepared[0],
      tx = TransactionBuilder.fromXdr(p.xdr, NETWORK);
    tx.sign(users[0]);
    assert.equal(
      (await app.submit(p.id, p.token, tx.toXdr())).state,
      "CONFIRMED",
    );
  });
  await check("zero-balance graduation rejected", () =>
    assert.rejects(() => app.maintenance(pool.id, users[0].publicKey())),
  );
  const handover = await app.maintenance(
    pool.id,
    users[1].publicKey(),
    config.sponsors[1],
  );
  await settled([handover.id]);
  await check("handover A to B without recipient signature", async () => {
    const a = await chain.account(users[1].publicKey());
    assert(a);
    assert.equal(sponsored(a, config.sponsors[1]).units, 3);
    assert.equal(native(a).balance, "0.0000000");
    assert.equal(a.signers.length, 1);
  });
  // Explicitly isolated test fixture funds the recipient. The application never sends this payment.
  const setup = JSON.parse(readFileSync(".local/setup-keys.json", "utf8"));
  const treasury = Keypair.fromSecret(setup.treasury);
  const ta = await chain.account(treasury.publicKey());
  const tx = new TransactionBuilder(new Account(ta!.account_id, ta!.sequence), {
    fee: "1000",
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.payment({
        destination: users[0].publicKey(),
        asset: Asset.native(),
        amount: "2",
      }),
    )
    .setTimeout(180)
    .build();
  tx.sign(treasury);
  await chain.submit(tx.toXdr());
  const graduation = await app.maintenance(pool.id, users[0].publicKey());
  await settled([graduation.id]);
  await check("graduation removes account and TL sponsorship", async () => {
    const a = await chain.account(users[0].publicKey());
    assert(a);
    assert.equal(sponsored(a, pool.sponsor).units, 0);
    assert.equal(a.num_sponsored, 0);
    assert.equal(a.signers[0].key, users[0].publicKey());
    assert.equal(native(a).balance, "2.0000000");
  });
  await app.policy(pool.id, false);
  await check("paused pool rejects new recipient", () =>
    assert.rejects(() =>
      app.prepare(
        app.invitation(pool, users[10].publicKey()),
        users[10].publicKey(),
      ),
    ),
  );
  await app.policy(pool.id, true);
  const state = await store.read();
  for (const i of state.intents.filter(
    (i) => i.pool === pool.id && i.state === "CONFIRMED",
  )) {
    evidence.transactions.push({
      kind: i.kind,
      recipient: i.recipient,
      hash: i.hash,
      innerHash: i.innerHash,
      ledger: i.ledger,
      fee: i.feeActual,
      result: await chain.result(i.hash!),
    });
  }
  evidence.accounts = await Promise.all(
    users.slice(0, 10).map((u) => chain.account(u.publicKey())),
  );
  evidence.sponsorBefore = sponsorBefore;
  evidence.sponsorsAfter = await Promise.all(
    config.sponsors.map((a) => chain.account(a)),
  );
  evidence.feePayerBefore = payerBefore;
  evidence.feePayerAfter = await chain.account(config.feePayer);
  evidence.fixtureFundingHash = hex(tx.hash());
  evidence.finishedAt = new Date().toISOString();
  evidence.success = true;
  mkdirSync("docs/evidence", { recursive: true });
  writeFileSync(
    "docs/evidence/testnet-" + run + ".json",
    JSON.stringify(evidence, null, 2),
  );
  console.log("EVIDENCE", "docs/evidence/testnet-" + run + ".json");
} catch (e) {
  evidence.error = (e as Error).message;
  writeFileSync(
    ".local/testnet-failure-" + run + ".json",
    JSON.stringify(evidence, null, 2),
  );
  throw e;
} finally {
  await store.close();
}
