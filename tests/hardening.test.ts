import { Cardea } from "../src/service.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./helpers.ts";
import { server } from "../src/server.ts";
import { signerServer } from "../src/signer-server.ts";
import { RemoteSigning, type SigningRequest } from "../src/signing.ts";
import { TransactionBuilder, Operation, Asset } from "@stellar/stellar-sdk";
import { NETWORK, onboarding } from "../src/stellar.ts";
import { validateConfig } from "../src/config.ts";
const relay = (
  ip: string,
  secret: string,
  path = "/api/admin/login",
  method = "POST",
  delta = 0,
) => {
  const time = String(Math.floor(Date.now() / 1000) + delta);
  return {
    "x-cardea-ip": ip,
    "x-cardea-time": time,
    "x-cardea-signature": createHmac("sha256", secret)
      .update(JSON.stringify([method, path, ip, time]))
      .digest("hex"),
  };
};
test("trusted relay isolates clients and rejects spoofed, stale and path-replayed attestations", async () => {
  const f = await fixture(),
    secret = "test-relay-secret-".repeat(3);
  f.config.relaySecret = secret;
  const http = await server(f.app);
  try {
    const login = (ip: string, password: string, extra = {}) =>
      http.inject({
        method: "POST",
        url: "/api/admin/login",
        remoteAddress: "127.0.0.1",
        headers: { origin: f.config.origin, ...relay(ip, secret), ...extra },
        payload: { password },
      });
    for (let n = 0; n < 5; n++)
      assert.equal((await login("198.51.100.1", "wrong")).statusCode, 401);
    assert.equal(
      (await login("198.51.100.1", "test-operator-password-long")).statusCode,
      429,
    );
    assert.equal(
      (await login("203.0.113.2", "test-operator-password-long")).statusCode,
      200,
    );
    assert.equal(
      (
        await login("203.0.113.2", "test-operator-password-long", {
          "x-cardea-ip": "203.0.113.3",
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await login(
          "203.0.113.2",
          "test-operator-password-long",
          relay("203.0.113.2", secret, undefined, undefined, -100),
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await http.inject({
          url: "/api/health",
          headers: relay("203.0.113.2", secret),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await http.inject({
          url: "/api/health",
          headers: { "x-forwarded-for": "203.0.113.2" },
        })
      ).statusCode,
      403,
    );
  } finally {
    await http.close();
    await f.close();
  }
});
test("login limits password work across client IPs without blocking health", async () => {
  const f = await fixture(),
    secret = "global-login-test-".repeat(3);
  f.config.relaySecret = secret;
  const http = await server(f.app);
  try {
    const login = (n: number) =>
      http.inject({
        method: "POST",
        url: "/api/admin/login",
        remoteAddress: "127.0.0.1",
        headers: {
          origin: f.config.origin,
          ...relay(`198.51.100.${n}`, secret),
        },
        payload: { password: "wrong" },
      });
    const burst = await Promise.all([login(1), login(2), login(3)]);
    assert.equal(burst.filter((r) => r.statusCode === 429).length, 1);
    assert.equal(burst.filter((r) => r.statusCode === 401).length, 2);
    const health = await http.inject({
      url: "/api/health",
      headers: relay("203.0.113.1", secret, "/api/health", "GET"),
    });
    assert.notEqual(health.statusCode, 429);
    // A distributed sequence is still capped even when no client hits its own limit.
    for (let n = 4; n <= 21; n++)
      assert.equal((await login(n)).statusCode, 401);
    assert.equal((await login(22)).statusCode, 429);
  } finally {
    await http.close();
    await f.close();
  }
});
test("invalid invitation causes no Horizon work", async () => {
  const f = await fixture();
  let calls = 0;
  f.chain.snapshot = async () => {
    calls++;
    throw new Error("must not call");
  };
  try {
    await assert.rejects(f.app.prepare("invalid", f.users[0].publicKey()));
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});
test("slow Horizon observation does not hold DB lock and policy is revalidated", async () => {
  const f = await fixture();
  const snapshot = f.chain.snapshot.bind(f.chain);
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((r) => (release = r)),
    seen = new Promise<void>((r) => (entered = r));
  f.chain.snapshot = async () => {
    entered();
    await blocked;
    return snapshot();
  };
  const preparing = f.prepare();
  const rejected = assert.rejects(preparing);
  await seen;
  try {
    await Promise.race([
      f.store.change((s) => {
        s.pools.find((p) => p.id === f.p.id)!.status = "PAUSED";
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("DB lock held during network wait")),
          1000,
        ),
      ),
    ]);
  } finally {
    release();
    await rejected;
    await f.close();
  }
});
test("isolated signer rebuilds templates, enforces durable ceilings and accepts valid onboarding", async () => {
  const f = await fixture(),
    dir = mkdtempSync(join(tmpdir(), "cardea-signer-")),
    socket = join(dir, "sign.sock"),
    journal = join(dir, "journal.json");
  let daemon = signerServer(f.config, journal, { count: 1, fee: "10000000", maintenanceReserve: 0 });
  const listen = () => new Promise<void>((r) => daemon.listen(socket, r));
  const close = () =>
    new Promise<void>((r, j) => daemon.close((e) => (e ? j(e) : r())));
  await listen();
  const remote = new RemoteSigning(socket);
  const make = (n: number): SigningRequest => {
    const tx = onboarding({
      channel: f.config.channels[n],
      sequence: "1",
      sponsor: f.config.sponsors[0],
      recipient: f.users[n].publicKey(),
      expires: Math.floor(Date.now() / 1000) + 100,
    });
    tx.sign(f.users[n]);
    return {
      kind: "onboard",
      sponsor: f.config.sponsors[0],
      recipient: f.users[n].publicKey(),
      channel: f.config.channels[n],
      sequence: tx.sequence,
      expires: Number(tx.timeBounds!.maxTime),
      xdr: tx.toXdr(),
    };
  };
  try {
    const good = make(0);
    const tx = TransactionBuilder.fromXdr(good.xdr, NETWORK);
    const bad = TransactionBuilder.cloneFrom(tx as any)
      .addOperation(
        Operation.payment({
          destination: f.users[0].publicKey(),
          asset: Asset.native(),
          amount: "1",
          source: f.config.sponsors[0],
        }),
      )
      .build();
    bad.sign(f.users[0]);
    await assert.rejects(remote.sign({ ...good, xdr: bad.toXdr() }));
    await assert.rejects(
      remote.sign({ ...good, sponsor: f.users[1].publicKey() }),
    );
    await assert.rejects(
      remote.sign({ ...good, sequence: "0" + good.sequence }),
    );
    const signed = await remote.sign(good);
    assert.equal(signed.innerTransaction.operations.length, 4);
    assert.equal((await remote.sign(good)).toXdr(), signed.toXdr());
    await assert.rejects(remote.sign(make(1)));
    await close();
    daemon = signerServer(f.config, journal, { count: 1, fee: "10000000", maintenanceReserve: 0 });
    await listen();
    await assert.rejects(remote.sign(make(1)));
    assert.equal((await remote.sign(good)).toXdr(), signed.toXdr());
    assert.equal(JSON.parse(readFileSync(journal, "utf8")).length, 1);
    const publicConfig = validateConfig({
      ...f.config,
      keys: [],
      signerSocket: socket,
    });
    assert.equal(publicConfig.keys.length, 0);
    assert.throws(() => validateConfig({ ...f.config, signerSocket: socket }));
  } finally {
    await close();
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Vercel declares CSP for all HTML routes", () => {
  const config = JSON.parse(readFileSync("vercel.json", "utf8"));
  const csp = config.headers
    .find((r: any) => r.source === "/(.*)")
    .headers.find((h: any) => h.key === "Content-Security-Policy").value;
  for (const policy of [
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ])
    assert.ok(csp.includes(policy));
  assert.ok(!csp.includes("unsafe-eval"));
});

test("relay authorization covers encoded and absolute-form API aliases", async () => {
  const f = await fixture();
  f.config.relaySecret = "alias-secret-".repeat(4);
  const http = await server(f.app);
  try {
    for (const url of [
      "/%61pi/admin/login",
      "http://localhost/api/admin/login",
      "/api/%61dmin/login",
    ]) {
      const result = await http.inject({
        method: "POST",
        url,
        headers: { origin: f.config.origin },
        payload: { password: "wrong" },
      });
      assert.equal(result.statusCode, 403, url);
    }
  } finally {
    await http.close();
    await f.close();
  }
});
test("heartbeat/session revisions do not starve allocation", async () => {
  const f = await fixture();
  const snapshot = f.chain.snapshot.bind(f.chain);
  let calls = 0;
  f.chain.snapshot = async () => {
    calls++;
    await f.store.change((s) => {
      s.workerAt = Math.floor(Date.now() / 1000);
      s.sessions.push({ hash: "irrelevant", csrf: "irrelevant", expires: 0 });
    });
    return snapshot();
  };
  try {
    const prepared = await f.prepare();
    assert.ok(prepared.id);
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test("keyless application completes remote onboarding and graduation", async () => {
  const f = await fixture(),
    dir = mkdtempSync(join(tmpdir(), "cardea-remote-flow-")),
    socket = join(dir, "sign.sock");
  const daemon = signerServer(f.config, join(dir, "journal.json"));
  await new Promise<void>((r) => daemon.listen(socket, r));
  const app = new Cardea(
    f.store,
    f.chain,
    validateConfig({ ...f.config, keys: [], signerSocket: socket }),
  );
  try {
    const prepared = await app.prepare(
      app.invitation(f.p, f.users[0].publicKey()),
      f.users[0].publicKey(),
    );
    const tx = TransactionBuilder.fromXdr(prepared.xdr, NETWORK);
    tx.sign(f.users[0]);
    assert.equal(
      (await app.submit(prepared.id, prepared.token, tx.toXdr())).state,
      "READY",
    );
    await app.tick();
    await app.tick();
    assert.equal(
      (await app.status(prepared.id, prepared.token)).state,
      "CONFIRMED",
    );
    f.chain.accounts.get(f.users[0].publicKey())!.balances[0].balance =
      "2.0000000";
    const graduation = await app.maintenance(f.p.id, f.users[0].publicKey());
    assert.equal(graduation.state, "READY");
    await app.tick();
    await app.tick();
    assert.equal((await f.store.read()).pools[0].sponsorships[0].units, 0);
  } finally {
    await new Promise<void>((r, j) => daemon.close((e) => (e ? j(e) : r())));
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
