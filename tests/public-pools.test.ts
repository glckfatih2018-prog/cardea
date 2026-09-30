import test from "node:test";
import assert from "node:assert/strict";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { fixture } from "./helpers.ts";
import { NETWORK } from "../src/stellar.ts";

test("private pools stay private; public listing reveals only name and id", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.app.publicPools(), []);
    await assert.rejects(
      f.publicPrepare(f.users[0].publicKey(), f.p.id),
      /Invitation unavailable/,
    );
    await f.app.setAccess(f.p.id, "public");
    assert.deepEqual(await f.app.publicPools(), [
      { id: f.p.id, name: f.p.name },
    ]);
    await f.app.policy(f.p.id, false);
    assert.deepEqual(await f.app.publicPools(), []);
  } finally {
    await f.close();
  }
});
test("unlisted recipient signs public sponsorship; duplicate is rejected", async () => {
  const f = await fixture();
  try {
    await f.app.allowlist(f.p.id, [f.users[0].publicKey()], true);
    await f.app.setAccess(f.p.id, "public");
    const r = await f.publicPrepare(f.users[0].publicKey(), f.p.id);
    await f.sign(r);
    await f.land();
    const user = await f.chain.account(f.users[0].publicKey());
    assert.equal(user?.num_sponsored, 3);
    assert.equal(user?.balances[0].balance, "0.0000000");
    assert.equal(
      (await f.store.read()).pools[0].allowlist.includes(
        f.users[0].publicKey(),
      ),
      false,
    );
    await assert.rejects(f.publicPrepare(f.users[0].publicKey(), f.p.id));
  } finally {
    await f.close();
  }
});
test("revoking public access blocks prepared public request before signing", async () => {
  const f = await fixture();
  try {
    await f.app.setAccess(f.p.id, "public");
    const r = await f.publicPrepare(f.users[0].publicKey(), f.p.id);
    await f.app.setAccess(f.p.id, "private");
    await assert.rejects(f.sign(r), /Address no longer allowed/);
    assert.equal(f.chain.submissions.length, 0);
  } finally {
    await f.close();
  }
});
test("public pending requests cannot occupy all channels; invitation path remains usable", async () => {
  const f = await fixture();
  try {
    await f.app.setAccess(f.p.id, "public");
    const max = Math.floor(f.config.channels.length / 2);
    for (let n = 0; n < max; n++)
      await f.publicPrepare(f.users[n].publicKey(), f.p.id);
    await assert.rejects(
      f.publicPrepare(f.users[max].publicKey(), f.p.id),
      /Public pools are busy/,
    );
    await f.prepare(max + 1);
  } finally {
    await f.close();
  }
});
test("existing account gets only sponsored trustline, correct accounting and graduation", async () => {
  const f = await fixture();
  try {
    const recipient = f.users[0].publicKey();
    f.chain.accounts.set(recipient, {
      ...structuredClone(f.chain.accounts.get(f.config.feePayer)!),
      account_id: recipient,
      signers: [{ key: recipient, weight: 1 }],
    });
    await f.app.setAccess(f.p.id, "public");
    const r = await f.publicPrepare(recipient, f.p.id);
    const tx = TransactionBuilder.fromXdr(r.xdr, NETWORK) as any;
    assert.deepEqual(
      tx.operations.map((o: any) => o.type),
      [
        "beginSponsoringFutureReserves",
        "changeTrust",
        "endSponsoringFutureReserves",
      ],
    );
    await f.sign(r);
    await f.land();
    assert.equal((await f.store.read()).pools[0].sponsorships[0].units, 1);
    assert.equal((await f.chain.account(recipient))?.num_sponsored, 1);
    await f.app.maintenance(f.p.id, recipient);
    await f.land();
    assert.equal((await f.chain.account(recipient))?.num_sponsored, 0);
  } finally {
    await f.close();
  }
});

test("public HTTP flow rejects forged admission fields and protects visibility changes", async () => {
  const f = await fixture();
  const { server } = await import("../src/server.ts");
  const http = await server(f.app);
  try {
    const headers = { origin: f.config.origin };
    const denied = await http.inject({
      method: "POST",
      url: "/api/admin/pools/" + f.p.id + "/access",
      headers,
      payload: { access: "public" },
    });
    assert.equal(denied.statusCode, 401);
    await f.app.setAccess(f.p.id, "public");
    const list = await http.inject({
      method: "GET",
      url: "/api/onboarding/pools",
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.headers["cache-control"], "private, no-store");
    for (const payload of [
      {
        pool: f.p.id,
        invite: f.app.invitation(f.p, f.users[0].publicKey()),
        recipient: f.users[0].publicKey(),
      },
      { pool: f.p.id, recipient: f.users[0].publicKey(), trustlineOnly: true },
    ]) {
      const res = await http.inject({
        method: "POST",
        url: "/api/onboarding/prepare",
        headers,
        payload,
      });
      assert.equal(res.statusCode, 400);
    }
    const r = await http.inject({
      method: "POST",
      url: "/api/onboarding/prepare",
      headers,
      payload: { pool: f.p.id, recipient: f.users[0].publicKey() },
    });
    assert.equal(r.statusCode, 200);
  } finally {
    await http.close();
    await f.close();
  }
});
test("public sponsorship keeps reserve caps and canonical signature enforcement", async () => {
  const f = await fixture();
  try {
    await f.app.setAccess(f.p.id, "public");
    await f.app.limits(f.p.id, "0.5", "1");
    await assert.rejects(f.publicPrepare(f.users[0].publicKey(), f.p.id));
    await f.app.limits(f.p.id, "100", "1");
    const r = await f.publicPrepare(f.users[0].publicKey(), f.p.id);
    const tx = TransactionBuilder.fromXdr(r.xdr, NETWORK);
    tx.sign(f.users[1]);
    await assert.rejects(
      f.app.submit(r.id, r.token, tx.toXdr()),
      /Invalid signature/,
    );
  } finally {
    await f.close();
  }
});
