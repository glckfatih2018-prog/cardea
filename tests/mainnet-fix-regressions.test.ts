import test from "node:test";
import assert from "node:assert/strict";
import { FeeBumpTransaction, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { fixture } from "./helpers.ts";
import { NETWORK, hex } from "../src/stellar.ts";
import { now } from "../src/model.ts";
import { GRADUATIONS_PER_TICK } from "../src/service.ts";

test("foreign fee bump of the exact signed inner reconciles once without charging sponsor", async () => {
  const f = await fixture();
  try {
    const r = await f.prepare(0);
    await f.sign(r, 0);
    const before = await f.store.read();
    const row = before.intents.find((i) => i.id === r.id)!;
    const own = TransactionBuilder.fromXdr(row.envelope!, NETWORK);
    assert.ok(own instanceof FeeBumpTransaction);
    const foreign = Keypair.random();
    f.chain.accounts.set(foreign.publicKey(), {
      account_id: foreign.publicKey(), sequence: "1", num_sponsoring: 0,
      num_sponsored: 0, subentry_count: 0,
      balances: [{ asset_type: "native", balance: "100" }],
      signers: [{ key: foreign.publicKey(), weight: 1 }],
    });
    const replacement = TransactionBuilder.buildFeeBumpTransaction(
      foreign, "10000", own.innerTransaction, NETWORK,
    );
    replacement.sign(foreign);
    assert.notEqual(hex(replacement.hash()), row.hash);
    assert.equal(hex(replacement.innerTransaction.hash()), row.innerHash);
    await f.chain.submit(replacement.toXdr());
    await f.app.tick();
    await f.app.tick();
    const state = await f.store.read();
    const settled = state.intents.find((i) => i.id === r.id)!;
    assert.equal(settled.state, "CONFIRMED");
    assert.equal(settled.landedHash, hex(replacement.hash()));
    assert.equal(settled.feeActual, "0");
    assert.equal(state.haltReason, undefined);
    assert.equal(state.pools[0].sponsorships.filter((x) => x.recipient === f.users[0].publicKey()).length, 1);
    assert.equal(state.pools[0].consumed.filter((x) => x === f.users[0].publicKey()).length, 1);
  } finally {
    await f.close();
  }
});

test("unresolved signed envelope does not starve coherent monitoring", async () => {
  const f = await fixture();
  try {
    const r = await f.prepare(0);
    await f.sign(r, 0);
    f.chain.unknownSubmit = true;
    await f.app.tick();
    await f.store.change((s) => { s.monitorAt = now() - 91; });
    await f.app.tick();
    const s = await f.store.read();
    assert.equal(s.intents.find((i) => i.id === r.id)?.state, "UNKNOWN");
    assert.ok(now() - s.monitorAt! < 5);
    assert.equal(s.haltReason, undefined);
    assert.ok((await f.prepare(1)).id);
  } finally {
    await f.close();
  }
});

test("one public client gets one unsigned hold; legitimate private invitation supersedes it", async () => {
  const f = await fixture();
  try {
    await f.app.setAccess(f.p.id, "public");
    const first = await f.publicPrepare(f.users[0].publicKey(), f.p.id, "203.0.113.1");
    await assert.rejects(f.publicPrepare(f.users[1].publicKey(), f.p.id, "203.0.113.1"),
      /One public request at a time/);
    const privateRequest = await f.prepare(0);
    const s = await f.store.read();
    assert.equal(s.intents.find((i) => i.id === first.id)?.state, "REJECTED");
    assert.equal(s.intents.find((i) => i.id === privateRequest.id)?.state, "AWAITING_SIGNATURE");
    assert.ok((await f.publicPrepare(f.users[2].publicKey(), f.p.id, "203.0.113.1")).id);
  } finally {
    await f.close();
  }
});

test("private invitation supersedes its own unsigned public hold even when the only channel and participant slot are occupied", async () => {
  const f = await fixture();
  try {
    f.config.channels.splice(1);
    await f.app.setAccess(f.p.id, "public");
    await f.app.profile(f.p.id, f.p.name, f.p.description ?? "", 1);
    const held = await f.publicPrepare(f.users[0].publicKey(), f.p.id);
    const invited = await f.prepare(0);
    const s = await f.store.read();
    assert.equal(s.intents.find((i) => i.id === held.id)?.state, "REJECTED");
    assert.equal(s.intents.find((i) => i.id === invited.id)?.state, "AWAITING_SIGNATURE");
    assert.equal(s.intents.find((i) => i.id === invited.id)?.channel, f.config.channels[0]);
  } finally {
    await f.close();
  }
});

test("locally impossible public admission does not call Horizon", async () => {
  const f = await fixture();
  try {
    await f.app.setAccess(f.p.id, "public");
    const first = await f.publicPrepare(f.users[0].publicKey());
    const oldSnapshot = f.chain.snapshot.bind(f.chain);
    const oldAccount = f.chain.account.bind(f.chain);
    let reads = 0;
    f.chain.snapshot = async () => { reads++; return oldSnapshot(); };
    f.chain.account = async (key) => { reads++; return oldAccount(key); };
    await assert.rejects(f.publicPrepare(f.users[1].publicKey(), f.p.id, "203.0.113.1"),
      /One public request at a time/);
    // Public caller cannot prepare the same wallet twice while it has a hold.
    await assert.rejects(f.publicPrepare(f.users[0].publicKey()),
      /already pending/);
    assert.equal(reads, 0);
    assert.equal((await f.store.read()).intents.find((i) => i.id === first.id)?.state,
      "AWAITING_SIGNATURE");
  } finally {
    await f.close();
  }
});

test("terminal intent leaves hot state and authenticated archive remains available", async () => {
  const f = await fixture();
  try {
    const r = await f.prepare(0);
    await f.sign(r, 0);
    await f.land();
    await f.store.change((s) => {
      s.intents.find((i) => i.id === r.id)!.created = now() - 8 * 86400;
    });
    await f.app.tick();
    const s = await f.store.read();
    assert.equal(s.intents.find((i) => i.id === r.id), undefined);
    const archived = await f.store.archived(r.id);
    assert.equal(archived?.state, "CONFIRMED");
    assert.equal((await f.app.status(r.id, r.token)).state, "CONFIRMED");
    await assert.rejects(f.app.status(r.id, "wrong-token"), /Request unavailable/);
  } finally {
    await f.close();
  }
});

test("automatic graduation visits eligible records fairly within a per-tick bound", async () => {
  const f = await fixture();
  try {
    const all = f.users.slice(0, 12).map((u) => u.publicKey());
    await f.store.change((s) => {
      s.pools[0].sponsorships = all.map((recipient) => ({
        recipient, sponsor: f.p.sponsor, units: 3, status: "ACTIVE", ledger: 100,
      }));
      s.eligible = all.slice(0, 11);
    });
    const visited: string[] = [];
    const app = f.app as unknown as {
      graduatePass: () => Promise<void>;
      maintenance: (pool: string, recipient: string) => Promise<unknown>;
    };
    app.maintenance = async (_pool, recipient) => { visited.push(recipient); return {}; };
    for (let n = 0; n < 3; n++) {
      const before = visited.length;
      await app.graduatePass();
      assert.equal(visited.length - before, GRADUATIONS_PER_TICK);
    }
    assert.equal(new Set(visited).size, 11);
    assert.ok(!visited.includes(all[11]));
  } finally {
    await f.close();
  }
});
