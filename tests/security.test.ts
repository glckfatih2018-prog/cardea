import test from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  TransactionBuilder,
  Memo,
  Networks,
  Account,
  Operation,
  Transaction,
} from "@stellar/stellar-sdk";
import {
  onboarding,
  verifyRecipient,
  NETWORK,
  available,
  units,
  hex,
  wrap,
} from "../src/stellar.ts";
import {
  validateConfig,
  passwordHash,
  passwordMatches,
} from "../src/config.ts";
import { fixture } from "./helpers.ts";
import { server } from "../src/server.ts";
const a = Keypair.random(),
  b = Keypair.random(),
  c = Keypair.random();
const build = () =>
  onboarding({
    sponsor: a.publicKey(),
    recipient: b.publicKey(),
    channel: c.publicKey(),
    sequence: "1",
    expires: 2000000000,
  });
function sign(tx: Transaction, key = b) {
  tx.sign(key);
  return tx.toXdr();
}
test("canonical unsigned payload accepts exactly the recipient signature", () => {
  const tx = build();
  const hash = hex(tx.hash()),
    xdr = tx.toXdr();
  assert.notEqual(sign(tx), xdr);
  const valid = verifyRecipient(xdr, tx.toXdr(), b.publicKey());
  assert.equal(hex(valid.hash()), hash);
});
for (const [name, options] of Object.entries({
  memo: { memo: Memo.text("changed") },
  fee: { fee: "10" },
  timeout: { timebounds: { minTime: 1, maxTime: 2000000001 } },
}))
  test("reject modified " + name, () => {
    const tx = build(),
      xdr = tx.toXdr();
    const changed = TransactionBuilder.cloneFrom(tx, options).build();
    assert.notEqual(hex(changed.hash()), hex(tx.hash()));
    assert.throws(() => verifyRecipient(xdr, sign(changed), b.publicKey()));
  });
test("reject changed recipient and source", () => {
  const tx = build(),
    other = onboarding({
      sponsor: b.publicKey(),
      recipient: a.publicKey(),
      channel: c.publicKey(),
      sequence: "1",
      expires: 2000000000,
    });
  assert.throws(() => verifyRecipient(tx.toXdr(), sign(other), b.publicKey()));
});
test("reject appended payment and SetOptions authority operation", () => {
  for (const op of [
    Operation.payment({
      destination: a.publicKey(),
      amount: "1",
      asset: awaitAsset(),
    }),
    Operation.setOptions({
      signer: { ed25519PublicKey: a.publicKey(), weight: 1 },
      source: b.publicKey(),
    }),
  ]) {
    const tx = build(),
      builder = TransactionBuilder.cloneFrom(tx).addOperation(op);
    assert.throws(() =>
      verifyRecipient(tx.toXdr(), sign(builder.build()), b.publicKey()),
    );
  }
});
import { Asset } from "@stellar/stellar-sdk";
function awaitAsset() {
  return Asset.native();
}
test("reject wrong signer with unchanged transaction", () => {
  const tx = build(),
    xdr = tx.toXdr();
  assert.throws(() => verifyRecipient(xdr, sign(tx, a), b.publicKey()));
});
test("reject absent or additional signatures", () => {
  const tx = build(),
    xdr = tx.toXdr();
  assert.throws(() => verifyRecipient(xdr, xdr, b.publicKey()));
  tx.sign(b, c);
  assert.throws(() => verifyRecipient(xdr, tx.toXdr(), b.publicKey()));
});
test("reject signature over mainnet payload", () => {
  const tx = build(),
    xdr = tx.toXdr();
  const other = TransactionBuilder.fromXdr(xdr, Networks.PUBLIC);
  other.sign(b);
  assert.throws(() => verifyRecipient(xdr, other.toXdr(), b.publicKey()));
});
test("reject fee bump supplied in place of inner envelope", () => {
  const tx = build(),
    xdr = tx.toXdr();
  const outer = wrap(tx, [a, b, c], a, 100);
  assert.throws(() => verifyRecipient(xdr, outer.toXdr(), b.publicKey()));
});
test("reject malformed, oversized and empty XDR", () => {
  for (const x of ["", "not xdr", "A".repeat(20001)])
    assert.throws(() => verifyRecipient(build().toXdr(), x, b.publicKey()));
});
test("exact stroop arithmetic rejects exponent, negative and overprecision", () => {
  assert.equal(units("1.5000000"), 15000000n);
  for (const s of ["1e3", "-1", "NaN", "1.00000001", "Infinity"])
    assert.throws(() => units(s));
});
test("password verification is salted and rejects incorrect values", async () => {
  const h = passwordHash("correct");
  assert(await passwordMatches("correct", h));
  assert(!(await passwordMatches("incorrect", h)));
  assert(!(await passwordMatches("a".repeat(257), h)));
});
test("fee cap rejects invalid numeric values", () => {
  for (const fee of [0, -1, 10001, NaN, Infinity, 100.1])
    assert.throws(() => wrap(build(), [a, b, c], a, fee));
});
test("mainnet and duplicate signer roles cannot configure runtime", async () => {
  const f = await fixture();
  try {
    assert.throws(() =>
      validateConfig({ ...f.config, network: Networks.PUBLIC }),
    );
    assert.throws(() =>
      validateConfig({ ...f.config, channels: [f.config.feePayer] }),
    );
    assert.throws(() =>
      validateConfig({ ...f.config, origin: "http://public.example" }),
    );
  } finally {
    await f.close();
  }
});
test("API guards origin, admin session, CSRF, size and unknown fields", async () => {
  const f = await fixture();
  const http = await server(f.app);
  try {
    assert.equal(
      (await http.inject({ url: "/api/admin/dashboard" })).statusCode,
      401,
    );
    assert.equal(
      (
        await http.inject({
          method: "POST",
          url: "/api/admin/login",
          payload: { password: "test-operator-password-long" },
          headers: { origin: "https://evil.example" },
        })
      ).statusCode,
      403,
    );
    const login = await http.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { password: "test-operator-password-long" },
      headers: { origin: f.config.origin },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookies[0].name + "=" + login.cookies[0].value;
    assert(login.headers["set-cookie"]?.toString().includes("HttpOnly"));
    assert(login.headers["set-cookie"]?.toString().includes("SameSite=Strict"));
    assert.equal(
      (
        await http.inject({
          method: "POST",
          url: `/api/admin/pools/${f.p.id}/policy`,
          payload: { active: false },
          headers: { cookie, origin: f.config.origin },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await http.inject({
          method: "POST",
          url: "/api/onboarding/prepare",
          payload: {
            invite: f.p.invite,
            recipient: f.users[0].publicKey(),
            source: f.config.feePayer,
          },
          headers: { origin: f.config.origin },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await http.inject({
          method: "POST",
          url: "/api/onboarding/prepare",
          payload: { x: "x".repeat(40000) },
          headers: { origin: f.config.origin },
        })
      ).statusCode,
      413,
    );
    const res = await http.inject({
      url: "/api/admin/dashboard",
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    for (const k of f.config.keys) assert(!res.body.includes(k));
    assert(!res.body.includes(f.config.operatorHash));
    assert.equal(
      (
        await http.inject({
          url: `/api/onboarding/${crypto.randomUUID()}/status`,
          headers: { authorization: "Bearer wrong" },
        })
      ).statusCode,
      404,
    );
  } finally {
    await http.close();
    await f.close();
  }
});
