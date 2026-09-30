import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { fixture } from "./helpers.ts";
import { Cardea } from "../src/service.ts";
import { Store } from "../src/db.ts";
import { available } from "../src/stellar.ts";
import { now, day } from "../src/model.ts";
async function use(
  fn: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  opts = {},
) {
  const f = await fixture(opts);
  try {
    await fn(f);
  } finally {
    await f.close();
  }
}
test("50-address import deduplicates and non-listed address fails", () =>
  use(async (f) => {
    await f.app.allowlist(f.p.id, [f.users[0].publicKey()]);
    assert.equal((await f.store.read()).pools[0].allowlist.length, 50);
    await assert.rejects(() =>
      f.app.prepare(f.p.invite, Keypair.random().publicKey()),
    );
  }));
test("10 concurrent requests lease distinct channels and settle once", () =>
  use(async (f) => {
    const r = await Promise.all(
      f.users
        .slice(0, 10)
        .map((u) =>
          f.app.prepare(f.app.invitation(f.p, u.publicKey()), u.publicKey()),
        ),
    );
    assert.equal(
      new Set((await f.store.read()).intents.map((i) => i.channel)).size,
      10,
    );
    await Promise.all(r.map((r, n) => f.sign(r, n)));
    await f.land();
    assert(
      (await f.store.read()).intents.every((i) => i.state === "CONFIRMED"),
    );
    assert.equal((await f.store.read()).pools[0].sponsorships.length, 10);
    await f.land();
    assert.equal((await f.store.read()).pools[0].sponsorships.length, 10);
  }));
test("parallel requests for same address reserve only once", () =>
  use(async (f) => {
    const r = await Promise.allSettled([f.prepare(), f.prepare()]);
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal((await f.store.read()).intents.length, 1);
  }));
test("same sponsor across pools cannot over-reserve physical balance", () =>
  use(async (f) => {
    f.chain.accounts.get(f.p.sponsor)!.balances[0].balance = "2.5000000";
    const other = await f.app.createPool("Other", f.p.sponsor, "100", "1");
    await f.app.allowlist(other.id, [f.users[1].publicKey()]);
    await f.app.policy(other.id, true);
    await f.prepare();
    await assert.rejects(() =>
      f.app.prepare(
        f.app.invitation(other, f.users[1].publicKey()),
        f.users[1].publicKey(),
      ),
    );
  }));
test("pool cap includes pending signature requests", () =>
  use(async (f) => {
    await f.store.change((s) => {
      s.pools[0].cap = "15000000";
    });
    await f.prepare();
    await assert.rejects(() => f.prepare(1));
  }));
test("fee budget reserves pending worst-case costs", () =>
  use(async (f) => {
    await f.store.change((s) => {
      s.pools[0].feeCap = "5000";
    });
    await f.prepare();
    await assert.rejects(() => f.prepare(1));
  }));
test("pause after prepare blocks co-sign while preserving request", () =>
  use(async (f) => {
    const r = await f.prepare();
    await f.app.policy(f.p.id, false);
    await assert.rejects(() => f.sign(r));
    assert.equal((await f.store.read()).intents[0].state, "AWAITING_SIGNATURE");
    assert.equal(f.chain.submissions.length, 0);
  }));
test("allowlist revocation before co-sign blocks request", () =>
  use(async (f) => {
    const r = await f.prepare();
    await f.app.allowlist(f.p.id, [f.users[0].publicKey()], true);
    await assert.rejects(() => f.sign(r));
  }));
test("expired unsigned request releases channel and reservation", () =>
  use(async (f) => {
    await f.prepare();
    f.chain.closedAt += 200;
    await f.app.tick();
    assert.equal((await f.store.read()).intents[0].state, "EXPIRED");
    await f.prepare(1);
  }));
test("durable UNKNOWN survives a new Store instance then reconciles", () =>
  use(async (f) => {
    const r = await f.prepare();
    await f.sign(r);
    f.chain.unknownSubmit = true;
    await f.app.tick();
    assert.equal((await f.store.read()).intents[0].state, "UNKNOWN");
    const secondStore = new Store(f.config.databaseUrl, f.config.namespace);
    try {
      const second = new Cardea(secondStore, f.chain, f.config);
      assert.equal((await secondStore.read()).intents[0].state, "UNKNOWN");
      f.chain.unknownSubmit = false;
      await f.chain.submit((await f.store.read()).intents[0].envelope!);
      await second.tick();
      assert.equal((await f.store.read()).intents[0].state, "CONFIRMED");
    } finally {
      await secondStore.close();
    }
  }));
test("ambiguous timeout never releases a signed request early", () =>
  use(async (f) => {
    const r = await f.prepare();
    await f.sign(r);
    f.chain.failSubmit = true;
    await f.app.tick();
    assert.equal((await f.store.read()).intents[0].state, "UNKNOWN");
    await assert.rejects(() => f.prepare());
  }));
test("expiry plus unconsumed sequence safely releases signed intent", () =>
  use(async (f) => {
    const r = await f.prepare();
    await f.sign(r);
    f.chain.unknownSubmit = true;
    await f.app.tick();
    f.chain.closedAt += 210;
    await f.app.tick();
    assert.equal((await f.store.read()).intents[0].state, "EXPIRED");
  }));
test("consumed sequence without history halts instead of guessing failure", () =>
  use(async (f) => {
    const r = await f.prepare();
    await f.sign(r);
    f.chain.unknownSubmit = true;
    await f.app.tick();
    const i = (await f.store.read()).intents[0];
    f.chain.accounts.get(i.channel)!.sequence = i.sequence;
    f.chain.closedAt += 210;
    await f.app.tick();
    assert((await f.store.read()).haltReason);
    assert.equal((await f.store.read()).intents[0].state, "UNKNOWN");
  }));
test("unexplained sponsor count automatically pauses", () =>
  use(async (f) => {
    f.chain.accounts.get(f.p.sponsor)!.num_sponsoring = 1;
    await f.app.tick();
    assert.equal((await f.store.read()).pools[0].status, "PAUSED");
    await assert.rejects(() => f.prepare());
  }));
test("stale ledger blocks prepare without mutation", () =>
  use(async (f) => {
    f.chain.stale = true;
    await assert.rejects(() => f.prepare());
    assert.equal((await f.store.read()).intents.length, 0);
  }));
test("a stale channel sequence cannot prepare a second transaction", () =>
  use(async (f) => {
    const first = await f.prepare();
    await f.sign(first);
    await f.land();
    const landed = (await f.store.read()).intents[0];
    assert.equal(landed.state, "CONFIRMED");
    const read = f.chain.accountWithLedger.bind(f.chain);
    f.chain.accountWithLedger = async (id) => {
      const observed = await read(id);
      if (id === landed.channel && observed.account)
        observed.account.sequence = String(BigInt(landed.sequence) - 1n);
      return observed;
    };
    await assert.rejects(() => f.prepare(1), /Channel sequence confirmation/);
    await assert.rejects(
      () =>
        f.app.maintenance(f.p.id, f.users[0].publicKey(), f.config.sponsors[1]),
      /Channel sequence confirmation/,
    );
    assert.equal((await f.store.read()).intents.length, 1);
    f.chain.accountWithLedger = read;
    assert.ok((await f.prepare(1)).id);
  }));
test("a lagging channel ledger cannot expire a signed transaction", () =>
  use(async (f) => {
    const prepared = await f.prepare();
    await f.sign(prepared);
    f.chain.unknownSubmit = true;
    await f.app.tick();
    f.chain.closedAt += 210;
    const read = f.chain.accountWithLedger.bind(f.chain);
    f.chain.accountWithLedger = async (id) => {
      const observed = await read(id);
      return { ...observed, ledger: observed.ledger - 1 };
    };
    await assert.rejects(() => f.app.tick(), /Ledger confirmation unavailable/);
    assert.equal((await f.store.read()).intents[0].state, "UNKNOWN");
    f.chain.accountWithLedger = read;
    await f.app.tick();
    assert.equal((await f.store.read()).intents[0].state, "EXPIRED");
  }));
test("testnet ledger regression halts runtime", () =>
  use(async (f) => {
    f.chain.ledger = 1;
    await f.app.tick();
    assert((await f.store.read()).haltReason);
    await assert.rejects(() => f.prepare());
  }));
test("worker heartbeat expiry blocks new requests", () =>
  use(async (f) => {
    await f.store.change((s) => {
      s.workerAt = now() - 120;
    });
    await assert.rejects(() => f.prepare());
  }));
test("DB transaction rollback preserves state and audit atomicity", () =>
  use(async (f) => {
    await assert.rejects(() =>
      f.store.change((s, audit) => {
        s.pools[0].cap = "0";
        audit({ action: "should_rollback" });
        throw new Error("crash");
      }),
    );
    assert.equal((await f.store.read()).pools[0].cap, "1000000000");
    assert(
      !(await f.store.events()).some(
        (e) => e.event.action === "should_rollback",
      ),
    );
  }));
test("wrong request token cannot read or sign", () =>
  use(async (f) => {
    const r = await f.prepare();
    await assert.rejects(() => f.app.status(r.id, "wrong"));
    await assert.rejects(() => f.app.submit(r.id, "wrong", r.xdr));
  }));
test("a verified recipient does not block another on the same UTC day", () =>
  use(async (f) => {
    const first = await f.prepare();
    await f.sign(first);
    await f.land();
    const second = await f.prepare(1);
    await f.sign(second, 1);
    await f.land();
    assert.equal((await f.store.read()).pools[0].sponsorships.length, 2);
  }));
test("graduation waits for reserve, then releases with no recipient signature", () =>
  use(async (f) => {
    const r = await f.prepare();
    await f.sign(r);
    await f.land();
    await assert.rejects(() =>
      f.app.maintenance(f.p.id, f.users[0].publicKey()),
    );
    f.chain.accounts.get(f.users[0].publicKey())!.balances[0].balance =
      "2.0000000";
    await f.app.maintenance(f.p.id, f.users[0].publicKey());
    await f.land();
    assert.equal(
      (await f.store.read()).pools[0].sponsorships[0].status,
      "GRADUATED",
    );
  }));
test("selling liabilities prevent unsafe graduation", () =>
  use(async (f) => {
    const r = await f.prepare();
    await f.sign(r);
    await f.land();
    const a = f.chain.accounts.get(f.users[0].publicKey())!;
    a.balances[0].balance = "2";
    a.balances[0].selling_liabilities = "1";
    assert(available(a, 5000000n, 3) < 0);
    await assert.rejects(() => f.app.maintenance(f.p.id, a.account_id));
  }));
test("handover changes reserve owner while retaining recipient signer", () =>
  use(async (f) => {
    const r = await f.prepare();
    await f.sign(r);
    await f.land();
    await f.app.maintenance(
      f.p.id,
      f.users[0].publicKey(),
      f.config.sponsors[1],
    );
    await f.land();
    assert.equal(
      (await f.store.read()).pools[0].sponsorships[0].sponsor,
      f.config.sponsors[1],
    );
    assert.equal(
      f.chain.accounts.get(f.users[0].publicKey())!.signers[0].key,
      f.users[0].publicKey(),
    );
  }));
test("handover requires configured funded destination and cannot race graduation", () =>
  use(async (f) => {
    const r = await f.prepare();
    await f.sign(r);
    await f.land();
    await assert.rejects(() =>
      f.app.maintenance(
        f.p.id,
        f.users[0].publicKey(),
        Keypair.random().publicKey(),
      ),
    );
    f.chain.accounts.get(f.config.sponsors[1])!.balances[0].balance = "1";
    await assert.rejects(() =>
      f.app.maintenance(f.p.id, f.users[0].publicKey(), f.config.sponsors[1]),
    );
    f.chain.accounts.get(f.config.sponsors[1])!.balances[0].balance = "100";
    await f.app.maintenance(
      f.p.id,
      f.users[0].publicKey(),
      f.config.sponsors[1],
    );
    await assert.rejects(() =>
      f.app.maintenance(f.p.id, f.users[0].publicKey()),
    );
  }));
test("external trustline closure reconciles a one-unit decrease", () =>
  use(async (f) => {
    const r = await f.prepare();
    await f.sign(r);
    await f.land();
    const a = f.chain.accounts.get(f.users[0].publicKey())!;
    a.balances = a.balances.filter((b) => !b.asset_code);
    a.num_sponsored--;
    a.subentry_count--;
    f.chain.accounts.get(f.p.sponsor)!.num_sponsoring--;
    await f.app.monitor();
    assert.equal((await f.store.read()).pools[0].sponsorships[0].units, 2);
    assert.equal((await f.store.read()).pools[0].status, "ACTIVE");
  }));
test("fee charged only once on replay reconciliation", () =>
  use(async (f) => {
    const r = await f.prepare();
    await f.sign(r);
    await f.land();
    const a = (await f.store.read()).pools[0].fees[day()];
    await f.sign(r);
    await f.land();
    assert.equal((await f.store.read()).pools[0].fees[day()], a);
  }));
test("invitation rotation invalidates old link", () =>
  use(async (f) => {
    await f.app.rotateInvite(f.p.id);
    await assert.rejects(() => f.prepare());
  }));
