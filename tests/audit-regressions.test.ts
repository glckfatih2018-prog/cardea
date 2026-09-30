import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.ts";
// These tests assert the intended repaired invariant; initially reproduce audit failures.
test("unsigned abandonment cannot consume another recipient daily admission", async () => {
  const f = await fixture({ attempts: 1 });
  try {
    await f.prepare();
    f.chain.closedAt += 200;
    await f.app.tick();
    await f.prepare(1);
  } finally {
    await f.close();
  }
});
test("actual ledger fee is attributed to inclusion day, not prepare day", async () => {
  const f = await fixture();
  try {
    const r = await f.prepare();
    await f.store.change((s) => {
      s.intents[0].feeDay = "2000-01-01";
    });
    await f.sign(r);
    await f.land();
    const p = (await f.store.read()).pools[0];
    assert.equal(p.fees["2000-01-01"], undefined);
    assert(BigInt(p.fees[new Date().toISOString().slice(0, 10)]) > 0n);
  } finally {
    await f.close();
  }
});
test("transient mixed-ledger count cannot permanently pause pool", async () => {
  const f = await fixture();
  try {
    const r = await f.prepare();
    await f.sign(r);
    await f.land();
    const original = f.chain.account.bind(f.chain);
    let changed = false;
    f.chain.account = async (id) => {
      const result = await original(id);
      if (id === f.users[0].publicKey() && !changed) {
        changed = true;
        f.chain.ledger++;
        const a = f.chain.accounts.get(id)!;
        a.balances = a.balances.filter((b) => !b.asset_code);
        a.num_sponsored--;
        a.subentry_count--;
        f.chain.accounts.get(f.p.sponsor)!.num_sponsoring--;
      }
      return result;
    };
    await f.app.monitor();
    assert.equal((await f.store.read()).pools[0].status, "ACTIVE");
  } finally {
    await f.close();
  }
});

test("invitation cannot be used for a different allowed recipient", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() =>
      f.app.prepare(
        f.app.invitation(f.p, f.users[0].publicKey()),
        f.users[1].publicKey(),
      ),
    );
    assert.equal((await f.store.read()).intents.length, 0);
  } finally {
    await f.close();
  }
});
test("abandoned requests have a recipient-scoped persistent retry cap", async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 3; n++) {
      await f.prepare();
      f.chain.closedAt += 200;
      await f.app.tick();
    }
    await assert.rejects(() => f.prepare());
    await f.prepare(1);
  } finally {
    await f.close();
  }
});
test("new work blocks when a coherent reserve sample is stale", async () => {
  const f = await fixture();
  try {
    await f.store.change((s) => {
      s.monitorAt = 0;
    });
    await assert.rejects(() => f.prepare());
  } finally {
    await f.close();
  }
});
test("pool limits cannot be reduced below paid or pending obligations", async () => {
  const f = await fixture();
  try {
    await f.prepare();
    await assert.rejects(() => f.app.limits(f.p.id, "1", "1"));
    await assert.rejects(() => f.app.limits(f.p.id, "10", "0.0000001"));
    await f.app.limits(f.p.id, "2", "0.01");
    assert.equal((await f.store.read()).pools[0].cap, "20000000");
  } finally {
    await f.close();
  }
});
test("a failed ledger transaction is charged once and creates no sponsorship", async () => {
  const f = await fixture();
  try {
    const r = await f.prepare();
    await f.sign(r);
    const i = (await f.store.read()).intents[0];
    f.chain.results.set(i.hash!, {
      hash: i.hash!,
      created_at: new Date().toISOString(),
      ledger: 101,
      successful: false,
      fee_charged: "500",
      result_xdr: "fake failure",
      envelope_xdr: i.envelope!,
    });
    await f.app.tick();
    await f.app.tick();
    const s = await f.store.read();
    assert.equal(s.intents[0].state, "FAILED");
    assert.equal(s.pools[0].sponsorships.length, 0);
    assert.equal(Object.values(s.pools[0].fees)[0], "500");
  } finally {
    await f.close();
  }
});
test("two workers cannot enter the same reconciliation critical section", async () => {
  const f = await fixture();
  try {
    let entered = 0;
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const first = f.store.workerLock(async () => {
      entered++;
      await hold;
    });
    for (let n = 0; n < 20 && entered === 0; n++)
      await new Promise((r) => setTimeout(r, 5));
    await f.store.workerLock(async () => {
      entered++;
    });
    release();
    await first;
    assert.equal(entered, 1);
  } finally {
    await f.close();
  }
});
test("corrupt signature hint cannot obtain a fee-paying envelope", async () => {
  const f = await fixture();
  try {
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const { NETWORK } = await import("../src/stellar.ts");
    const r = await f.prepare(),
      tx = TransactionBuilder.fromXdr(r.xdr, NETWORK);
    tx.sign(f.users[0]);
    tx.signatures[0].hint.value[0] ^= 255;
    await assert.rejects(() => f.app.submit(r.id, r.token, tx.toXdr()));
    assert.equal((await f.store.read()).intents[0].envelope, undefined);
  } finally {
    await f.close();
  }
});
test("alternate URL spellings never bypass operator authorization", async () => {
  const f = await fixture();
  const { server } = await import("../src/server.ts");
  const http = await server(f.app);
  try {
    for (const url of [
      "/api/admin/dashboard",
      "/api/%61dmin/dashboard",
      "/%61pi/admin/dashboard",
      "/api/admin%2fdashboard",
      "/api//admin/dashboard",
      "/api/admin/dashboard?x=1",
      "/api/admin/dashboard/",
      "/API/admin/dashboard",
    ]) {
      const r = await http.inject({ method: "GET", url });
      assert(
        r.statusCode >= 400,
        `Unexpected access at ${url}: ${r.statusCode}`,
      );
    }
  } finally {
    await http.close();
    await f.close();
  }
});

test("decoded admin aliases enforce identical session, origin and CSRF policy", async () => {
  const f = await fixture();
  const { server } = await import("../src/server.ts");
  const http = await server(f.app);
  try {
    const aliases = [
      "/api/admin/dashboard",
      "/api/%61dmin/dashboard",
      "/%61pi/admin/dashboard",
      "http://localhost:4317/api/%61dmin/dashboard",
    ];
    for (const url of aliases)
      assert.equal((await http.inject({ url })).statusCode, 401, url);
    const login = await http.inject({
      method: "POST",
      url: "/api/admin/login?next=app",
      headers: { origin: f.config.origin },
      payload: { password: "test-operator-password-long" },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookies[0].name + "=" + login.cookies[0].value,
      csrf = login.json().csrf;
    for (const url of aliases)
      assert.equal(
        (await http.inject({ url, headers: { cookie } })).statusCode,
        200,
        url,
      );
    for (const prefix of [
      "/api/%61dmin",
      "/%61pi/admin",
      "http://localhost:4317/%61pi/admin",
    ]) {
      const url = `${prefix}/pools/${f.p.id}/policy`,
        payload = { active: false };
      assert.equal(
        (
          await http.inject({
            method: "POST",
            url,
            payload,
            headers: { origin: f.config.origin },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await http.inject({
            method: "POST",
            url,
            payload,
            headers: { origin: f.config.origin, cookie },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await http.inject({
            method: "POST",
            url,
            payload,
            headers: {
              origin: "https://evil.example",
              cookie,
              "x-csrf-token": csrf,
            },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await http.inject({
            method: "POST",
            url,
            payload,
            headers: { origin: f.config.origin, cookie, "x-csrf-token": csrf },
          })
        ).statusCode,
        200,
      );
    }
  } finally {
    await http.close();
    await f.close();
  }
});

test("failed graduation has a persistent recipient cooldown across new intents", async () => {
  const f = await fixture();
  try {
    const r = await f.prepare();
    await f.sign(r);
    await f.land();
    f.chain.accounts.get(f.users[0].publicKey())!.balances[0].balance =
      "2.0000000";
    const first = await f.app.maintenance(f.p.id, f.users[0].publicKey());
    await f.store.change((s) => {
      const i = s.intents.find((i) => i.id === first.id)!;
      i.state = "FAILED";
      i.reason = "Ledger rejected transaction";
    });
    // A failed ledger transaction still consumes its channel sequence.
    const failed = (await f.store.read()).intents.find((i) => i.id === first.id)!;
    f.chain.accounts.get(failed.channel)!.sequence = failed.sequence;
    await assert.rejects(
      () => f.app.maintenance(f.p.id, f.users[0].publicKey()),
      /cooldown/,
    );
    await f.store.change((s) => {
      s.intents.find((i) => i.id === first.id)!.created -= 86401;
    });
    assert.equal(
      (await f.app.maintenance(f.p.id, f.users[0].publicKey())).state,
      "READY",
    );
  } finally {
    await f.close();
  }
});

test("handover replacement reserve is not double-counted against pool cap", async () => {
  const f = await fixture();
  try {
    const r = await f.prepare();
    await f.sign(r);
    await f.land();
    await f.app.limits(f.p.id, "3", "1");
    await f.app.maintenance(
      f.p.id,
      f.users[0].publicKey(),
      f.config.sponsors[1],
    );
    await f.prepare(1);
    const p = (await f.app.dashboard()).pools[0];
    assert.equal(p.activeReserve, "15000000");
    assert.equal(p.pendingReserve, "15000000");
  } finally {
    await f.close();
  }
});
test("health rejects stale coherent monitor despite fresh worker heartbeat", async () => {
  const f = await fixture();
  const { server } = await import("../src/server.ts");
  const http = await server(f.app);
  try {
    assert.equal((await http.inject({ url: "/api/health" })).statusCode, 200);
    await f.store.change((s) => {
      s.monitorAt = 0;
    });
    assert.equal((await http.inject({ url: "/api/health" })).statusCode, 503);
  } finally {
    await http.close();
    await f.close();
  }
});
