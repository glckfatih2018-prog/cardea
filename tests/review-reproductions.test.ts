import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { fixture as baseFixture } from "./helpers.ts";
import { Problem } from "../src/service.ts";
import { day, entriesOf, unitsOf, retryKey } from "../src/model.ts";
import { NETWORK, type ChainAccount } from "../src/stellar.ts";

// REGRESSIONS for the three review findings (A: victim quota poisoning,
// B: shared-sponsor entry ownership, C: worker lock / stale branch). Each test
// asserts the repaired behaviour and keeps the original positive controls.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Coherent time: the wall clock (Date, used by expiry(), day() and heartbeats)
 * is mocked at a stable midday and only advances together with the fake ledger
 * close time. Timers are left real so gates and sleeps behave normally.
 */
async function fixture(options: Parameters<typeof baseFixture>[0] = {}) {
  mock.timers.enable({
    apis: ["Date"],
    now: new Date().setUTCHours(12, 0, 0, 0),
  });
  const f = await baseFixture(options);
  const close = f.close;
  return {
    ...f,
    advance(seconds: number) {
      mock.timers.tick(seconds * 1000);
      f.chain.closedAt += seconds;
    },
    async close() {
      try {
        await close();
      } finally {
        mock.timers.reset();
      }
    },
  };
}

/** Simulate the wallet owner closing their (empty) USDC trustline on the ledger. */
function closeTrustline(
  accounts: Map<string, ChainAccount>,
  wallet: string,
  sponsor: string,
) {
  const a = accounts.get(wallet)!;
  const t = a.balances.find((b) => b.asset_code === "USDC");
  assert.ok(t, "trustline must exist before it can be closed");
  assert.equal(t!.balance, "0.0000000", "only an empty trustline can close");
  assert.equal(t!.sponsor, sponsor);
  a.balances = a.balances.filter((b) => b !== t);
  a.subentry_count -= 1;
  a.num_sponsored -= 1;
  accounts.get(sponsor)!.num_sponsoring -= 1;
}

function failedResult(hash: string, envelope: string) {
  return {
    hash,
    created_at: new Date().toISOString(),
    ledger: 101,
    successful: false,
    fee_charged: "500",
    result_xdr: "fake failure",
    envelope_xdr: envelope,
  };
}

test("A: third-party unsigned public prepares cannot exhaust a victim's retry cap on either path", async () => {
  const f = await fixture();
  try {
    const victim = f.users[0].publicKey();
    const invited = f.users[1].publicKey();
    await f.app.setAccess(f.p.id, "public");

    // Attacker: three prepare/expiry cycles naming each victim, never signed.
    for (const target of [victim, invited])
      for (let n = 0; n < 3; n++) {
        await f.publicPrepare(target, f.p.id);
        f.advance(200);
        await f.app.tick();
      }
    let s = await f.store.read();
    assert.equal(s.intents.length, 6);
    assert.ok(s.intents.every((i) => i.state === "EXPIRED" && !i.envelope));
    assert.equal(f.chain.submissions.length, 0);
    // No per-recipient counter of any scope was spent by unsigned public requests.
    assert.deepEqual(
      Object.keys(s.pools[0].prepares ?? {}).filter(
        (k) => k.endsWith(victim) || k.endsWith(invited),
      ),
      [],
    );
    assert.equal(s.pools[0].attempts[day()], undefined);

    // Victim proceeds on the public path and signs.
    const r = await f.publicPrepare(victim, f.p.id);
    assert.equal((await f.sign(r, 0)).state, "READY");
    await f.land();
    // The equivalent valid private invitation also proceeds.
    const r2 = await f.prepare(1);
    assert.equal((await f.sign(r2, 1)).state, "READY");
    await f.land();
    s = await f.store.read();
    assert.deepEqual(
      s.intents.filter((i) => i.state === "CONFIRMED").map((i) => i.recipient),
      [victim, invited],
    );
    assert.deepEqual(s.pools[0].consumed, [victim, invited]);
    // Only verified signatures consumed signed quota.
    assert.equal(s.pools[0].prepares![retryKey("signed", day(), victim)], 1);
    assert.equal(s.pools[0].prepares![retryKey("signed", day(), invited)], 1);
    assert.equal(s.pools[0].prepares![retryKey("private", day(), invited)], 1);
    assert.equal(s.pools[0].attempts[day()], 2);

    // A valid private invitation supersedes an unsigned public hold for the
    // same recipient. The superseded hold may never be signed or settled.
    const bystander = f.users[2].publicKey();
    const held = await f.publicPrepare(bystander, f.p.id);
    assert.ok((await f.prepare(2)).id);
    assert.equal(
      (await f.store.read()).intents.find((i) => i.id === held.id)?.state,
      "REJECTED",
    );
    f.advance(200);
    await f.app.tick();
    assert.ok((await f.prepare(2)).id);

    // Public half-channel cap remains in force for pending public requests.
    const max = Math.max(1, Math.floor(f.config.channels.length / 2));
    for (let n = 0; n < max; n++)
      await f.publicPrepare(f.users[10 + n].publicKey(), f.p.id);
    await assert.rejects(
      f.publicPrepare(f.users[20].publicKey(), f.p.id),
      /Public pools are busy/,
    );
  } finally {
    await f.close();
  }
});

test("A: legacy day:recipient counters are ignored and the private abandonment cap stays invitation-scoped", async () => {
  const f = await fixture();
  try {
    const victim = f.users[0].publicKey();
    const abandoner = f.users[1].publicKey();
    // A poisoned counter persisted by the previous release.
    await f.store.change((s) => {
      s.pools[0].prepares = {
        [day() + ":" + victim]: 3,
        [day() + ":" + abandoner]: 3,
      };
    });
    await f.app.setAccess(f.p.id, "public");
    await f.publicPrepare(victim, f.p.id);
    f.advance(200);
    await f.app.tick();
    const r = await f.prepare(0);
    assert.equal((await f.sign(r, 0)).state, "READY");
    await f.land();
    assert.equal((await f.store.read()).intents.at(-1)!.state, "CONFIRMED");

    // Private abandonment is still capped per invitation holder...
    for (let n = 0; n < 3; n++) {
      await f.prepare(1);
      f.advance(200);
      await f.app.tick();
    }
    const s = await f.store.read();
    assert.equal(
      s.pools[0].prepares![retryKey("private", day(), abandoner)],
      3,
    );
    const denial = await f.prepare(1).then(
      () => null,
      (e: unknown) => e as Problem,
    );
    assert.ok(denial instanceof Problem);
    assert.equal(denial.status, 429);
    assert.equal(denial.message, "Recipient retry limit reached");
    // ...without touching signed quota or the public path for that wallet.
    assert.equal(
      s.pools[0].prepares![retryKey("signed", day(), abandoner)],
      undefined,
    );
    const pub = await f.publicPrepare(abandoner, f.p.id);
    assert.equal((await f.sign(pub, 1)).state, "READY");
    // Other invitation holders are unaffected.
    assert.ok((await f.prepare(2)).id);
  } finally {
    await f.close();
  }
});

test("A: invalid signatures, malformed envelopes and failed institution signing consume no signed quota", async () => {
  const f = await fixture();
  try {
    const recipient = f.users[0].publicKey();
    const key = retryKey("signed", day(), recipient);
    await f.app.setAccess(f.p.id, "public");
    const r = await f.publicPrepare(recipient, f.p.id);
    const wrong = TransactionBuilder.fromXdr(r.xdr, NETWORK);
    wrong.sign(f.users[1]);
    await assert.rejects(
      f.app.submit(r.id, r.token, wrong.toXdr()),
      /Invalid signature/,
    );
    await assert.rejects(
      f.app.submit(r.id, r.token, "not-an-envelope"),
      /Invalid signature or modified transaction/,
    );
    let s = await f.store.read();
    assert.equal(s.pools[0].prepares?.[key], undefined);
    assert.equal(s.pools[0].attempts[day()], undefined);
    assert.equal(s.intents[0].state, "AWAITING_SIGNATURE");

    // Institution signing failure rolls back both counters.
    const original = f.app.signing.sign.bind(f.app.signing);
    f.app.signing.sign = async () => {
      throw new Error("Signer rejected request");
    };
    await assert.rejects(f.sign(r, 0), /Signer rejected request/);
    s = await f.store.read();
    assert.equal(s.pools[0].prepares?.[key], undefined);
    assert.equal(s.pools[0].attempts[day()], undefined);
    assert.equal(s.intents[0].envelope, undefined);
    f.app.signing.sign = original;

    assert.equal((await f.sign(r, 0)).state, "READY");
    s = await f.store.read();
    assert.equal(s.pools[0].prepares![key], 1);
    assert.equal(s.pools[0].attempts[day()], 1);
  } finally {
    await f.close();
  }
});

test("A: signed daily retry cap is enforced after verification and remains meaningful across failed ledger results", async () => {
  const f = await fixture();
  try {
    const recipient = f.users[0].publicKey();
    const other = f.users[1].publicKey();
    const key = retryKey("signed", day(), recipient);
    await f.app.setAccess(f.p.id, "public");
    for (let n = 0; n < 3; n++) {
      const r = await f.publicPrepare(recipient, f.p.id);
      await f.sign(r, 0);
      const i = (await f.store.read()).intents.find((i) => i.id === r.id)!;
      f.chain.results.set(i.hash!, failedResult(i.hash!, i.envelope!));
      // A failed transaction in a ledger advances the channel sequence.
      f.chain.accounts.get(i.channel)!.sequence = i.sequence;
      f.chain.ledger++;
      await f.land();
      assert.equal(
        (await f.store.read()).intents.find((i) => i.id === r.id)!.state,
        "FAILED",
      );
    }
    let s = await f.store.read();
    assert.equal(s.pools[0].prepares![key], 3);
    assert.equal(s.pools[0].sponsorships.length, 0);
    // Preflight refuses a fourth signed attempt today, on both paths.
    await assert.rejects(
      f.publicPrepare(recipient, f.p.id),
      /Recipient retry limit reached/,
    );
    await assert.rejects(f.prepare(0), /Recipient retry limit reached/);
    // Other recipients are unaffected.
    const r2 = await f.publicPrepare(other, f.p.id);

    // Submission-time enforcement: the cap is checked again after signature
    // verification and never consumes quota on refusal.
    await f.store.change((s) => {
      s.pools[0].prepares![retryKey("signed", day(), other)] = 3;
    });
    const attemptsBefore = (await f.store.read()).pools[0].attempts[day()];
    await assert.rejects(f.sign(r2, 1), /Recipient retry limit reached/);
    s = await f.store.read();
    assert.equal(
      s.intents.find((i) => i.id === r2.id)!.state,
      "AWAITING_SIGNATURE",
    );
    assert.equal(s.intents.find((i) => i.id === r2.id)!.envelope, undefined);
    assert.equal(s.pools[0].attempts[day()], attemptsBefore);
    await f.store.change((s) => {
      s.pools[0].prepares![retryKey("signed", day(), other)] = 2;
    });
    assert.equal((await f.sign(r2, 1)).state, "READY");
    s = await f.store.read();
    assert.equal(s.pools[0].prepares![retryKey("signed", day(), other)], 3);
    assert.equal(s.pools[0].attempts[day()], attemptsBefore + 1);
  } finally {
    await f.close();
  }
});

test("B: shared sponsor across pools graduates each record's own entries; both pools stay active", async () => {
  const f = await fixture();
  try {
    const sponsor = f.config.sponsors[0];
    const wallet = f.users[0].publicKey();
    const control = f.users[1].publicKey();
    await f.sign(await f.prepare(0), 0);
    await f.land();
    await f.sign(await f.prepare(1), 1);
    await f.land();
    assert.equal(f.chain.accounts.get(sponsor)!.num_sponsoring, 6);

    closeTrustline(f.chain.accounts, wallet, sponsor);
    await f.app.tick();
    let s = await f.store.read();
    const poolA = () => s.pools.find((p) => p.id === f.p.id)!;
    const recordA = () =>
      poolA().sponsorships.find((r) => r.recipient === wallet)!;
    assert.equal(recordA().units, 2);

    const b = await f.app.createPool("Shared", sponsor, "100", "1");
    await f.app.policy(b.id, true);
    await f.app.setAccess(b.id, "public");
    await f.sign(await f.publicPrepare(wallet, b.id), 0);
    await f.land();
    s = await f.store.read();
    const poolB = () => s.pools.find((p) => p.id === b.id)!;
    assert.deepEqual(
      poolB().sponsorships.map((x) => [x.recipient, x.units, x.status]),
      [[wallet, 1, "ACTIVE"]],
    );
    assert.equal(recordA().units, 2);
    assert.equal(f.chain.accounts.get(sponsor)!.num_sponsoring, 6);

    f.chain.accounts.get(wallet)!.balances[0].balance = "10.0000000";
    f.chain.accounts.get(control)!.balances[0].balance = "10.0000000";

    // Pool A releases only the account entry it owns.
    const ga = await f.app.maintenance(f.p.id, wallet);
    assert.equal(ga.state, "READY");
    s = await f.store.read();
    const ia = s.intents.find((i) => i.id === ga.id)!;
    assert.deepEqual(ia.entries, { account: true, trustline: false });
    assert.deepEqual(
      (TransactionBuilder.fromXdr(ia.unsigned, NETWORK) as any).operations.map(
        (o: any) => o.type,
      ),
      ["revokeAccountSponsorship"],
    );
    await f.land();
    s = await f.store.read();
    assert.deepEqual([recordA().units, recordA().status], [0, "GRADUATED"]);
    assert.deepEqual(
      poolB().sponsorships.map((x) => [x.units, x.status]),
      [[1, "ACTIVE"]],
    );
    const w = f.chain.accounts.get(wallet)!;
    assert.equal(w.sponsor, undefined);
    assert.equal(
      w.balances.find((x) => x.asset_code === "USDC")!.sponsor,
      sponsor,
    );
    assert.equal(f.chain.accounts.get(sponsor)!.num_sponsoring, 4);

    // Pool B releases only its trustline entry.
    const gb = await f.app.maintenance(b.id, wallet);
    s = await f.store.read();
    assert.deepEqual(s.intents.find((i) => i.id === gb.id)!.entries, {
      account: false,
      trustline: true,
    });
    await f.land();
    s = await f.store.read();
    assert.deepEqual(
      poolB().sponsorships.map((x) => [x.units, x.status]),
      [[0, "GRADUATED"]],
    );
    assert.equal(f.chain.accounts.get(sponsor)!.num_sponsoring, 3);
    assert.equal((await f.app.maintenance(f.p.id, control)).state, "READY");
    await f.land();
    assert.equal(f.chain.accounts.get(sponsor)!.num_sponsoring, 0);
    s = await f.store.read();
    assert.equal(poolA().status, "ACTIVE");
    assert.equal(poolB().status, "ACTIVE");
    assert.equal(
      (await f.store.events()).filter(
        (e) => e.event.action === "pool.auto_paused",
      ).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("B: account-only handover leaves pool B's trustline untouched; B's closure is attributed to B only", async () => {
  const f = await fixture();
  try {
    const [s0, s1] = f.config.sponsors;
    const wallet = f.users[0].publicKey();
    await f.sign(await f.prepare(0), 0);
    await f.land();
    closeTrustline(f.chain.accounts, wallet, s0);
    await f.app.tick();
    const b = await f.app.createPool("Shared", s0, "100", "1");
    await f.app.policy(b.id, true);
    await f.app.setAccess(b.id, "public");
    await f.sign(await f.publicPrepare(wallet, b.id), 0);
    await f.land();

    const h = await f.app.maintenance(f.p.id, wallet, s1);
    let s = await f.store.read();
    const hi = s.intents.find((i) => i.id === h.id)!;
    assert.deepEqual(hi.entries, { account: true, trustline: false });
    assert.equal(hi.cost, String(2n * 5000000n));
    assert.deepEqual(
      (TransactionBuilder.fromXdr(hi.unsigned, NETWORK) as any).operations.map(
        (o: any) => o.type,
      ),
      [
        "beginSponsoringFutureReserves",
        "revokeAccountSponsorship",
        "endSponsoringFutureReserves",
      ],
    );
    await f.land();
    s = await f.store.read();
    const poolA = () => s.pools.find((p) => p.id === f.p.id)!;
    const poolB = () => s.pools.find((p) => p.id === b.id)!;
    assert.deepEqual(
      poolA().sponsorships.map((x) => [x.sponsor, x.units, x.status]),
      [[s1, 2, "TRANSFERRED"]],
    );
    assert.deepEqual(
      poolB().sponsorships.map((x) => [x.sponsor, x.units, x.status]),
      [[s0, 1, "ACTIVE"]],
    );
    const w = f.chain.accounts.get(wallet)!;
    assert.equal(w.sponsor, s1);
    assert.equal(w.balances.find((x) => x.asset_code === "USDC")!.sponsor, s0);
    assert.equal(f.chain.accounts.get(s0)!.num_sponsoring, 1);
    assert.equal(f.chain.accounts.get(s1)!.num_sponsoring, 2);
    assert.equal(poolA().status, "ACTIVE");
    assert.equal(poolB().status, "ACTIVE");

    // The wallet closes the trustline pool B paid for: only B's record changes.
    closeTrustline(f.chain.accounts, wallet, s0);
    await f.app.tick();
    s = await f.store.read();
    assert.deepEqual(
      poolB().sponsorships.map((x) => [x.units, x.status]),
      [[0, "CLOSED"]],
    );
    assert.deepEqual(
      poolA().sponsorships.map((x) => [x.units, x.status]),
      [[2, "TRANSFERRED"]],
    );
    assert.equal(poolA().status, "ACTIVE");
    assert.equal(poolB().status, "ACTIVE");
    const events = (await f.store.events()).map((e) => e.event);
    assert.equal(
      events.filter((e) => e.action === "pool.auto_paused").length,
      0,
    );
    const changes = events.filter(
      (e) => e.action === "sponsorship.external_change" && e.pool === b.id,
    );
    assert.deepEqual(
      changes.map((e) => [e.before, e.after]),
      [[1, 0]],
    );
  } finally {
    await f.close();
  }
});

test("B: records under different sponsors for one wallet graduate independently", async () => {
  const f = await fixture();
  try {
    const [s0, s1] = f.config.sponsors;
    const wallet = f.users[0].publicKey();
    await f.sign(await f.prepare(0), 0);
    await f.land();
    closeTrustline(f.chain.accounts, wallet, s0);
    await f.app.tick();
    const b = await f.app.createPool("Other sponsor", s1, "100", "1");
    await f.app.policy(b.id, true);
    await f.app.setAccess(b.id, "public");
    await f.sign(await f.publicPrepare(wallet, b.id), 0);
    await f.land();
    let s = await f.store.read();
    const poolA = () => s.pools.find((p) => p.id === f.p.id)!;
    const poolB = () => s.pools.find((p) => p.id === b.id)!;
    assert.deepEqual(
      poolA().sponsorships.map((x) => [x.sponsor, x.units]),
      [[s0, 2]],
    );
    assert.deepEqual(
      poolB().sponsorships.map((x) => [x.sponsor, x.units]),
      [[s1, 1]],
    );
    assert.equal(f.chain.accounts.get(s0)!.num_sponsoring, 2);
    assert.equal(f.chain.accounts.get(s1)!.num_sponsoring, 1);

    f.chain.accounts.get(wallet)!.balances[0].balance = "10.0000000";
    assert.equal((await f.app.maintenance(b.id, wallet)).state, "READY");
    await f.land();
    s = await f.store.read();
    assert.deepEqual(
      poolB().sponsorships.map((x) => x.units),
      [0],
    );
    assert.deepEqual(
      poolA().sponsorships.map((x) => x.units),
      [2],
    );
    assert.equal(f.chain.accounts.get(s1)!.num_sponsoring, 0);
    assert.equal(f.chain.accounts.get(s0)!.num_sponsoring, 2);
    assert.equal((await f.app.maintenance(f.p.id, wallet)).state, "READY");
    await f.land();
    s = await f.store.read();
    assert.deepEqual(
      poolA().sponsorships.map((x) => x.units),
      [0],
    );
    assert.equal(f.chain.accounts.get(s0)!.num_sponsoring, 0);
    assert.equal(poolA().status, "ACTIVE");
    assert.equal(poolB().status, "ACTIVE");
  } finally {
    await f.close();
  }
});

test("B: closing and reopening in another pool before the monitor runs releases the stale claim at preparation", async () => {
  const f = await fixture();
  try {
    const sponsor = f.config.sponsors[0];
    const wallet = f.users[0].publicKey();
    await f.sign(await f.prepare(0), 0);
    await f.land();
    const b = await f.app.createPool("Shared", sponsor, "100", "1");
    await f.app.policy(b.id, true);
    await f.app.setAccess(b.id, "public");

    // The wallet closes its trustline and immediately joins pool B; no monitor
    // pass has observed the closure yet.
    closeTrustline(f.chain.accounts, wallet, sponsor);
    const r = await f.publicPrepare(wallet, b.id);
    let s = await f.store.read();
    const poolA = () => s.pools.find((p) => p.id === f.p.id)!;
    const poolB = () => s.pools.find((p) => p.id === b.id)!;
    // Preparation already released the absent trustline from pool A's record
    // while keeping its still-valid account claim, and reserved nothing for B yet.
    assert.deepEqual(
      poolA().sponsorships.map((x) => [x.units, x.status]),
      [[2, "ACTIVE"]],
    );
    assert.equal(poolB().sponsorships.length, 0);
    const change = (await f.store.events())
      .map((e) => e.event)
      .find((e) => e.action === "sponsorship.external_change");
    assert.deepEqual(
      [change?.pool, change?.recipient, change?.before, change?.after],
      [f.p.id, wallet, 3, 2],
    );

    await f.sign(r, 0);
    await f.land();
    s = await f.store.read();
    assert.deepEqual(
      poolB().sponsorships.map((x) => [x.units, x.status]),
      [[1, "ACTIVE"]],
    );
    assert.deepEqual(
      poolA().sponsorships.map((x) => x.units),
      [2],
    );
    assert.equal(f.chain.accounts.get(sponsor)!.num_sponsoring, 3);
    assert.equal(poolA().status, "ACTIVE");
    assert.equal(poolB().status, "ACTIVE");
    assert.equal(
      (await f.store.events()).filter(
        (e) => e.event.action === "pool.auto_paused",
      ).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("B: account merged and recreated in another pool before the monitor runs releases the whole stale record at preparation", async () => {
  const f = await fixture();
  try {
    const sponsor = f.config.sponsors[0];
    const wallet = f.users[0].publicKey();
    await f.sign(await f.prepare(0), 0);
    await f.land();
    const b = await f.app.createPool("Shared", sponsor, "100", "1");
    await f.app.policy(b.id, true);
    await f.app.setAccess(b.id, "public");

    // The account (with its sponsored trustline) is merged away on the ledger;
    // both sponsored entries vanish. No monitor pass has observed it yet.
    assert.ok(f.chain.accounts.delete(wallet));
    f.chain.accounts.get(sponsor)!.num_sponsoring -= 3;
    const r = await f.publicPrepare(wallet, b.id);
    let s = await f.store.read();
    const poolA = () => s.pools.find((p) => p.id === f.p.id)!;
    const poolB = () => s.pools.find((p) => p.id === b.id)!;
    assert.deepEqual(
      poolA().sponsorships.map((x) => [x.units, x.status]),
      [[0, "CLOSED"]],
    );
    assert.equal(poolB().sponsorships.length, 0);
    const change = (await f.store.events())
      .map((e) => e.event)
      .find((e) => e.action === "sponsorship.external_change");
    assert.deepEqual(
      [change?.pool, change?.recipient, change?.before, change?.after],
      [f.p.id, wallet, 3, 0],
    );
    // Full onboarding (account + trustline) is prepared for the new pool.
    assert.deepEqual(
      (TransactionBuilder.fromXdr(r.xdr, NETWORK) as any).operations.map(
        (o: any) => o.type,
      ),
      [
        "beginSponsoringFutureReserves",
        "createAccount",
        "changeTrust",
        "endSponsoringFutureReserves",
      ],
    );
    await f.sign(r, 0);
    await f.land();
    s = await f.store.read();
    assert.deepEqual(
      poolB().sponsorships.map((x) => [x.units, x.status]),
      [[3, "ACTIVE"]],
    );
    assert.deepEqual(
      poolA().sponsorships.map((x) => x.units),
      [0],
    );
    assert.equal(f.chain.accounts.get(sponsor)!.num_sponsoring, 3);
    assert.equal(f.chain.accounts.get(wallet)!.num_sponsored, 3);
    assert.equal(poolA().status, "ACTIVE");
    assert.equal(poolB().status, "ACTIVE");
    assert.equal(
      (await f.store.events()).filter(
        (e) => e.event.action === "pool.auto_paused",
      ).length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("a stale missing recipient read cannot release a confirmed reserve claim", async () => {
  const f = await fixture();
  try {
    const wallet = f.users[0].publicKey();
    await f.sign(await f.prepare(0), 0);
    await f.land();
    const b = await f.app.createPool(
      "Second",
      f.config.sponsors[0],
      "100",
      "1",
    );
    await f.app.policy(b.id, true);
    await f.app.setAccess(b.id, "public");
    const actualAccount = f.chain.account.bind(f.chain);
    f.chain.account = async (id) => (id === wallet ? null : actualAccount(id));

    await assert.rejects(() => f.publicPrepare(wallet, b.id));
    let state = await f.store.read();
    assert.equal(
      state.pools.find((p) => p.id === f.p.id)!.sponsorships[0].units,
      3,
    );
    assert.equal(state.intents.filter((i) => i.pool === b.id).length, 0);

    await f.app.monitor();
    state = await f.store.read();
    assert.equal(
      state.pools.find((p) => p.id === f.p.id)!.sponsorships[0].units,
      3,
    );
    assert.equal(f.chain.accounts.get(f.config.sponsors[0])!.num_sponsoring, 3);
  } finally {
    await f.close();
  }
});

test("a mixed-ledger recipient response cannot release reserve after a real closure", async () => {
  const f = await fixture();
  try {
    const wallet = f.users[0].publicKey();
    await f.sign(await f.prepare(0), 0);
    await f.land();
    const b = await f.app.createPool(
      "Second",
      f.config.sponsors[0],
      "100",
      "1",
    );
    await f.app.policy(b.id, true);
    await f.app.setAccess(b.id, "public");
    closeTrustline(f.chain.accounts, wallet, f.config.sponsors[0]);
    const observed = f.chain.accountWithLedger.bind(f.chain);
    f.chain.accountWithLedger = async (id) => {
      const reading = await observed(id);
      return id === wallet
        ? { ...reading, ledger: reading.ledger - 1 }
        : reading;
    };
    await assert.rejects(
      () => f.publicPrepare(wallet, b.id),
      /Ledger confirmation unavailable/,
    );
    assert.equal(
      (await f.store.read()).pools.find((p) => p.id === f.p.id)!.sponsorships[0]
        .units,
      3,
    );
  } finally {
    await f.close();
  }
});

test("a ledger older than the booked sponsorship cannot retire its claim", async () => {
  const f = await fixture();
  try {
    const wallet = f.users[0].publicKey();
    await f.sign(await f.prepare(0), 0);
    await f.land();
    const b = await f.app.createPool(
      "Second",
      f.config.sponsors[0],
      "100",
      "1",
    );
    await f.app.policy(b.id, true);
    await f.app.setAccess(b.id, "public");
    const booked = (await f.store.read()).pools.find((p) => p.id === f.p.id)!
      .sponsorships[0].ledger;
    f.chain.ledger = booked - 1;
    const real = f.chain.account.bind(f.chain);
    f.chain.account = async (id) => (id === wallet ? null : real(id));
    await assert.rejects(
      () => f.publicPrepare(wallet, b.id),
      /Ledger confirmation unavailable/,
    );
    assert.equal(
      (await f.store.read()).pools.find((p) => p.id === f.p.id)!.sponsorships[0]
        .units,
      3,
    );
  } finally {
    await f.close();
  }
});

test("B: legacy overlapping ownership blocks manual and automatic maintenance before signing; disjoint records proceed", async () => {
  const f = await fixture({ autoGraduate: true });
  const signing = f.app.signing.sign.bind(f.app.signing);
  let signed = 0;
  f.app.signing.sign = async (input) => {
    signed++;
    return signing(input);
  };
  try {
    const [s0, s1] = f.config.sponsors;
    const wallet = f.users[0].publicKey();
    await f.sign(await f.prepare(0), 0);
    await f.land();
    const signedOnboard = signed;
    // Legacy state: pool B also claims the wallet's trustline under the same sponsor.
    const b = await f.app.createPool("Legacy", s0, "100", "1");
    await f.store.change((s) => {
      s.pools
        .find((p) => p.id === b.id)!
        .sponsorships.push({
          recipient: wallet,
          sponsor: s0,
          units: 1,
          status: "ACTIVE",
          ledger: 1,
        });
    });
    f.chain.accounts.get(wallet)!.balances[0].balance = "10.0000000";
    // The aggregate mismatch pauses pool A; the records are not repaired.
    await f.app.tick();
    let s = await f.store.read();
    const poolA = () => s.pools.find((p) => p.id === f.p.id)!;
    const poolB = () => s.pools.find((p) => p.id === b.id)!;
    assert.equal(poolA().status, "PAUSED");
    assert.deepEqual(
      poolA().sponsorships.map((x) => x.units),
      [3],
    );
    assert.deepEqual(
      poolB().sponsorships.map((x) => x.units),
      [1],
    );
    // Automatic graduation created no intent and asked for no signature.
    assert.equal(s.intents.filter((i) => i.kind !== "onboard").length, 0);
    assert.equal(signed, signedOnboard);
    // Manual graduation and handover from either record are refused.
    for (const [pool, target] of [
      [f.p.id, undefined],
      [f.p.id, s1],
      [b.id, undefined],
      [b.id, s1],
    ] as const)
      await assert.rejects(
        f.app.maintenance(pool, wallet, target),
        /Sponsorship ownership ambiguous/,
      );
    await f.app.tick();
    s = await f.store.read();
    assert.equal(s.intents.filter((i) => i.kind !== "onboard").length, 0);
    assert.equal(signed, signedOnboard);
    assert.equal(f.chain.submissions.length, 1);

    // Positive control: once pool A owns only the account (disjoint from B's
    // trustline), pool A's graduation is allowed and revokes only the account.
    await f.store.change((s) => {
      s.pools.find((p) => p.id === f.p.id)!.sponsorships[0].units = 2;
    });
    const g = await f.app.maintenance(f.p.id, wallet);
    assert.equal(g.state, "READY");
    assert.equal(signed, signedOnboard + 1);
    s = await f.store.read();
    assert.deepEqual(s.intents.find((i) => i.id === g.id)!.entries, {
      account: true,
      trustline: false,
    });
  } finally {
    f.app.signing.sign = signing;
    await f.close();
  }
});

test("B: units helper decodes legacy 0/1/2/3 only; corrupt or double-booked records fail closed", async () => {
  assert.deepEqual(entriesOf(0), { account: false, trustline: false });
  assert.deepEqual(entriesOf(1), { account: false, trustline: true });
  assert.deepEqual(entriesOf(2), { account: true, trustline: false });
  assert.deepEqual(entriesOf(3), { account: true, trustline: true });
  for (const u of [0, 1, 2, 3]) assert.equal(unitsOf(entriesOf(u)), u);
  for (const bad of [-1, 4, 1.5, "3", null, undefined, NaN])
    assert.throws(() => entriesOf(bad), /Invalid sponsorship units/);

  const f = await fixture();
  try {
    const wallet = f.users[0].publicKey();
    await f.sign(await f.prepare(0), 0);
    await f.land();
    // A corrupt persisted record is neither reconciled nor graduated.
    await f.store.change((s) => {
      s.pools[0].sponsorships[0].units = 5;
    });
    await assert.rejects(f.app.monitor(), /Invalid sponsorship units/);
    f.chain.accounts.get(wallet)!.balances[0].balance = "10.0000000";
    await assert.rejects(
      f.app.maintenance(f.p.id, wallet),
      /Invalid sponsorship units/,
    );
    await f.store.change((s) => {
      s.pools[0].sponsorships[0].units = 3;
    });
    // A legacy double-booked record for the same entries is not silently
    // repaired: the aggregate mismatch pauses the pool with an audit event.
    await f.store.change((s) => {
      s.pools[0].sponsorships.push({ ...s.pools[0].sponsorships[0] });
    });
    await f.app.tick();
    const s = await f.store.read();
    assert.deepEqual(
      s.pools[0].sponsorships.map((x) => x.units),
      [3, 3],
    );
    assert.equal(s.pools[0].status, "PAUSED");
    assert.equal(s.pools[0].reason, "Unexplained sponsor reserve count");
    const paused = (await f.store.events())
      .map((e) => e.event)
      .find((e) => e.action === "pool.auto_paused");
    assert.deepEqual([paused?.expected, paused?.actual], [6, 3]);
  } finally {
    await f.close();
  }
});

test("C: tick holds the worker lock until every branch settles, then propagates the failure; later ticks confirm once", async () => {
  const f = await fixture();
  const originalResult = f.chain.result.bind(f.chain);
  let releaseGate: (v: null) => void = () => {};
  const gate = new Promise<null>((r) => (releaseGate = r));
  let gateEntered: () => void = () => {};
  const entered = new Promise<void>((r) => (gateEntered = r));
  let armed = true;
  try {
    const r1 = await f.prepare(0);
    await f.sign(r1, 0);
    const r2 = await f.prepare(1);
    await f.sign(r2, 1);
    let s = await f.store.read();
    const h1 = s.intents.find((i) => i.id === r1.id)!.hash!;
    const h2 = s.intents.find((i) => i.id === r2.id)!.hash!;

    // Branch for h1 fails deterministically; branch for h2 hangs on a gate.
    f.chain.result = async (hash: string) => {
      if (armed && hash === h1) throw new Error("Horizon unavailable");
      if (armed && hash === h2) {
        gateEntered();
        return gate;
      }
      return originalResult(hash);
    };
    const ticking = f.app.tick();
    const outcome = assert.rejects(ticking, /Horizon unavailable/);
    await entered;
    // The failing branch has already rejected, yet the tick is not settled...
    assert.equal(
      await Promise.race([
        ticking.then(
          () => "settled",
          () => "settled",
        ),
        sleep(150).then(() => "pending"),
      ]),
      "pending",
    );
    // ...and the advisory lock is still held: a second worker is excluded.
    let ran = false;
    assert.equal(
      await f.store.workerLock(async () => {
        ran = true;
      }),
      undefined,
    );
    assert.equal(ran, false);
    assert.equal(await f.app.tick(), undefined);
    s = await f.store.read();
    assert.equal(s.intents.find((i) => i.id === r2.id)!.state, "READY");
    assert.equal(f.chain.submissions.length, 0);

    // Release the hanging branch: it completes its own (first) submission
    // inside the same tick, after which the tick rejects with the h1 error.
    armed = false;
    releaseGate(null);
    await outcome;
    s = await f.store.read();
    const i1 = () => s.intents.find((i) => i.id === r1.id)!;
    const i2 = () => s.intents.find((i) => i.id === r2.id)!;
    assert.deepEqual([i1().state, i1().attempts], ["READY", 0]);
    assert.deepEqual([i2().state, i2().attempts], ["UNKNOWN", 1]);
    assert.equal(f.chain.submissions.length, 1);
    let reentered = false;
    await f.store.workerLock(async () => {
      reentered = true;
    });
    assert.equal(reentered, true);

    await f.app.tick();
    await f.app.tick();
    await f.app.tick();
    s = await f.store.read();
    assert.deepEqual([i1().state, i1().attempts], ["CONFIRMED", 1]);
    assert.deepEqual([i2().state, i2().attempts], ["CONFIRMED", 1]);
    assert.equal(f.chain.submissions.length, 2);
    assert.equal(s.pools[0].consumed.length, 2);
    assert.equal(s.pools[0].sponsorships.length, 2);
    assert.equal(
      BigInt(s.pools[0].fees[i1().feeDay]),
      BigInt(i1().feeActual!) + BigInt(i2().feeActual!),
    );
    assert.equal(s.pools[0].status, "ACTIVE");
    assert.equal(
      (await f.store.events()).filter(
        (e) => e.event.action === "pool.auto_paused",
      ).length,
      0,
    );
  } finally {
    armed = false;
    releaseGate(null);
    await f.close();
  }
});

test("C: stale branches cannot revive or resubmit terminal rows; a normal UNKNOWN retry books exactly once", async () => {
  const f = await fixture();
  const originalResult = f.chain.result.bind(f.chain);
  try {
    const snap = await f.chain.snapshot();
    // A READY row observed by a slow branch, then confirmed by a normal worker.
    const r1 = await f.prepare(0);
    await f.sign(r1, 0);
    let s = await f.store.read();
    const stale1 = structuredClone(s.intents.find((i) => i.id === r1.id)!);
    await f.land();
    s = await f.store.read();
    const i1 = () => s.intents.find((i) => i.id === r1.id)!;
    assert.equal(i1().state, "CONFIRMED");
    const booked = {
      fees: s.pools[0].fees[i1().feeDay],
      consumed: s.pools[0].consumed.length,
      sponsorships: s.pools[0].sponsorships.length,
      submissions: f.chain.submissions.length,
    };
    const check = async () => {
      s = await f.store.read();
      assert.equal(i1().state, "CONFIRMED");
      assert.equal(i1().attempts, 1);
      assert.equal(s.pools[0].fees[i1().feeDay], booked.fees);
      assert.equal(s.pools[0].consumed.length, booked.consumed);
      assert.equal(s.pools[0].sponsorships.length, booked.sponsorships);
      assert.equal(f.chain.submissions.length, booked.submissions);
      assert.equal(s.haltReason, undefined);
    };
    // Stale "no result yet" observation must neither reset to UNKNOWN nor resend.
    f.chain.result = async () => null;
    await f.app.settle(stale1, snap);
    await check();
    // Stale expiry observation must not mark a confirmed row EXPIRED or halt.
    await f.app.settle(stale1, { ...snap, closedAt: stale1.expires + 100 });
    await check();
    // A repeated result observation must not book fees or sponsorship twice.
    f.chain.result = originalResult;
    await f.app.settle(stale1, snap);
    await check();

    // A row that expired unconsumed is not confirmed by a late result.
    const r2 = await f.prepare(1);
    await f.sign(r2, 1);
    f.chain.unknownSubmit = true;
    await f.app.tick();
    s = await f.store.read();
    const i2 = () => s.intents.find((i) => i.id === r2.id)!;
    assert.equal(i2().state, "UNKNOWN");
    const stale2 = structuredClone(i2());
    f.chain.unknownSubmit = false;
    f.advance(210);
    await f.app.tick();
    s = await f.store.read();
    assert.equal(i2().state, "EXPIRED");
    const late = f.chain.snapshot.bind(f.chain);
    f.chain.results.set(stale2.hash!, {
      hash: stale2.hash!,
      created_at: new Date().toISOString(),
      successful: true,
      ledger: 999,
      fee_charged: "5000",
      result_xdr: "late",
      envelope_xdr: stale2.envelope!,
    });
    const submissionsBefore = f.chain.submissions.length;
    await f.app.settle(stale2, await late());
    // Stale "no result" view on the resubmit path cannot resend an expired row.
    f.chain.result = async () => null;
    await f.app.settle(
      { ...stale2, lastAttempt: 0 },
      { ...snap, closedAt: stale2.expires - 100 },
    );
    f.chain.result = originalResult;
    s = await f.store.read();
    assert.equal(i2().state, "EXPIRED");
    assert.equal(i2().attempts, 1);
    assert.equal(f.chain.submissions.length, submissionsBefore);
    assert.equal(s.pools[0].sponsorships.length, 1);
    assert.equal(s.pools[0].consumed.length, 1);

    // A branch working from a different hash or an older attempt never applies.
    const r3 = await f.prepare(2);
    await f.sign(r3, 2);
    s = await f.store.read();
    const i3 = () => s.intents.find((i) => i.id === r3.id)!;
    const ready3 = structuredClone(i3());
    f.chain.result = async (hash) =>
      hash === "00".repeat(32)
        ? {
            hash,
            created_at: new Date().toISOString(),
            successful: true,
            ledger: 1000,
            fee_charged: "5000",
            result_xdr: "other",
            envelope_xdr: ready3.envelope!,
          }
        : null;
    await f.app.settle({ ...ready3, hash: "00".repeat(32) }, snap);
    s = await f.store.read();
    assert.deepEqual([i3().state, i3().attempts], ["READY", 0]);
    f.chain.result = originalResult;

    // Normal path: ambiguous submission, then retry after the interval, booked once.
    const fees0 = BigInt(s.pools[0].fees[day()] ?? "0");
    f.chain.failSubmit = true;
    await f.app.tick();
    f.chain.failSubmit = false;
    s = await f.store.read();
    assert.deepEqual([i3().state, i3().attempts], ["UNKNOWN", 1]);
    const afterFirst = f.chain.submissions.length;
    // Stale READY observation (attempt 0) cannot resend on top of attempt 1.
    f.chain.result = async () => null;
    await f.app.settle(ready3, snap);
    f.chain.result = originalResult;
    assert.equal(f.chain.submissions.length, afterFirst);
    // Too early for a retry: still UNKNOWN, no resend.
    await f.app.tick();
    s = await f.store.read();
    assert.deepEqual([i3().state, i3().attempts], ["UNKNOWN", 1]);
    assert.equal(f.chain.submissions.length, afterFirst);
    await f.store.change((st) => {
      st.intents.find((i) => i.id === r3.id)!.lastAttempt! -= 20;
    });
    await f.app.tick();
    s = await f.store.read();
    assert.deepEqual([i3().state, i3().attempts], ["UNKNOWN", 2]);
    assert.equal(f.chain.submissions.length, afterFirst + 1);
    await f.app.tick();
    s = await f.store.read();
    assert.equal(i3().state, "CONFIRMED");
    assert.equal(
      BigInt(s.pools[0].fees[day()]),
      fees0 + BigInt(i3().feeActual!),
    );
    assert.equal(
      s.pools[0].consumed.filter((a) => a === f.users[2].publicKey()).length,
      1,
    );
    assert.equal(
      s.pools[0].sponsorships.filter(
        (x) => x.recipient === f.users[2].publicKey(),
      ).length,
      1,
    );
    assert.equal(s.pools[0].status, "ACTIVE");
  } finally {
    f.chain.result = originalResult;
    await f.close();
  }
});
