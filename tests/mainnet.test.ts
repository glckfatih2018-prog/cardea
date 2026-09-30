import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { fixture } from "./helpers.ts";
import {
  TESTNET,
  MAINNET,
  resolveNetwork,
  publicProfile,
} from "../src/network.ts";
import {
  NETWORK,
  onboarding,
  maintenance,
  verifyRecipient,
  wrap,
  units,
} from "../src/stellar.ts";
import {
  validateConfig,
  MAINNET_ACKNOWLEDGEMENT,
  type Config,
} from "../src/config.ts";
import {
  canonicalSigning,
  RemoteSigning,
  type SigningRequest,
} from "../src/signing.ts";
import { signerServer, signerLimitsOf } from "../src/signer-server.ts";
import { Store } from "../src/db.ts";
import { Cardea } from "../src/service.ts";
import { server } from "../src/server.ts";
import {
  parseNetworkInfo,
  explorerLink,
  friendbotLink,
  networkLabel,
  networkBadge,
  networkSpecificCopy,
} from "../web/src/network.ts";

const ack = { acknowledge: MAINNET_ACKNOWLEDGEMENT };
/** A complete, valid mainnet service-role configuration derived from a testnet fixture. */
const mainnetService = (c: Config, socket = "/run/cardea-signer/sign.sock") =>
  ({
    ...c,
    network: MAINNET.passphrase,
    origin: "https://cardea.example",
    namespace: "mainnet_" + c.namespace,
    relaySecret: "relay-secret-".repeat(4),
    keys: [],
    signerSocket: socket,
    mainnet: ack,
    reserveCeiling: "100",
    signerLimits: { count: 50, fee: "1", maintenanceReserve: 10 },
    publicDailyAdmissions: 20,
  }) as Record<string, unknown>;
const mainnetSigner = (c: Config) => {
  const s = mainnetService(c);
  delete s.signerSocket;
  delete s.relaySecret;
  return { ...s, keys: c.keys } as Record<string, unknown>;
};

test("mainnet pools cannot share a sponsor account or its deposited XLM", async () => {
  const f = await fixture();
  const c = validateConfig(mainnetService(f.config));
  const store = new Store(c.databaseUrl, c.namespace, MAINNET.passphrase);
  try {
    await store.init();
    const app = new Cardea(store, f.chain, c);
    const first = await app.createPool("First", c.sponsors[0], "15", "0.02");
    await assert.rejects(
      app.createPool("Second", c.sponsors[0], "15", "0.02"),
      /separate funded sponsor account/,
    );
    const second = await app.createPool("Second", c.sponsors[1], "15", "0.02");
    const dashboard = await app.dashboard();
    assert.equal(dashboard.pools.length, 2);
    assert.deepEqual(dashboard.assignedSponsors, c.sponsors);
    assert.notEqual(first.sponsor, second.sponsor);
    assert.equal(
      dashboard.sponsorAccounts[c.sponsors[0]]?.balance,
      units("1000").toString(),
    );
    assert.equal(
      dashboard.sponsorAccounts[c.sponsors[0]]?.available,
      units("999").toString(),
    );
  } finally {
    await store.db.query("DELETE FROM cardea_audit WHERE namespace=$1", [
      c.namespace,
    ]);
    await store.db.query("DELETE FROM cardea_state WHERE id=$1", [c.namespace]);
    await store.close();
    await f.close();
  }
});

test("network profiles resolve exact passphrases only and bind distinct issuers", () => {
  assert.equal(resolveNetwork(Networks.TESTNET), TESTNET);
  assert.equal(resolveNetwork(Networks.PUBLIC), MAINNET);
  assert.equal(
    MAINNET.passphrase,
    "Public Global Stellar Network ; September 2015",
  );
  assert.equal(MAINNET.horizon, "https://horizon.stellar.org");
  assert.equal(
    MAINNET.issuer,
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  );
  assert.equal(MAINNET.friendbot, null);
  assert.notEqual(MAINNET.issuer, TESTNET.issuer);
  assert.notEqual(MAINNET.horizon, TESTNET.horizon);
  assert.notEqual(MAINNET.explorer, TESTNET.explorer);
  for (const bad of [
    "",
    undefined,
    null,
    42,
    MAINNET.passphrase + " ",
    " " + TESTNET.passphrase,
    "Public Global Stellar Network ; September 2016",
    { passphrase: MAINNET.passphrase },
  ])
    assert.throws(() => resolveNetwork(bad), /Unknown network passphrase/);
  assert.ok(Object.isFrozen(MAINNET) && Object.isFrozen(TESTNET));
  assert.deepEqual(Object.keys(publicProfile(MAINNET)).sort(), [
    "explorer",
    "friendbot",
    "horizon",
    "issuer",
    "name",
    "passphrase",
  ]);
});

test("builders serve both profiles simultaneously and cross-network signatures are rejected", () => {
  const channel = Keypair.random(),
    sponsor = Keypair.random(),
    payer = Keypair.random(),
    recipient = Keypair.random();
  const input = {
    channel: channel.publicKey(),
    sequence: "1",
    sponsor: sponsor.publicKey(),
    recipient: recipient.publicKey(),
    expires: Math.floor(Date.now() / 1000) + 100,
  };
  const t = onboarding(input, TESTNET),
    m = onboarding(input, MAINNET),
    legacy = onboarding(input);
  assert.equal(
    Buffer.from(legacy.hash()).toString("hex"),
    Buffer.from(t.hash()).toString("hex"),
  );
  assert.notEqual(
    Buffer.from(t.hash()).toString("hex"),
    Buffer.from(m.hash()).toString("hex"),
  );
  const issuerOf = (tx: any) =>
    tx.operations.find((o: any) => o.type === "changeTrust").line.getIssuer();
  assert.equal(issuerOf(t), TESTNET.issuer);
  assert.equal(issuerOf(m), MAINNET.issuer);
  assert.equal(m.networkPassphrase, MAINNET.passphrase);
  const mt = maintenance(input, undefined, undefined, MAINNET);
  assert.equal((mt.operations[0] as any).asset.getIssuer(), MAINNET.issuer);
  // Recipient signs the mainnet body.
  const signedMain = TransactionBuilder.fromXdr(m.toXdr(), MAINNET.passphrase);
  signedMain.sign(recipient);
  const okTx = verifyRecipient(
    m.toXdr(),
    signedMain.toXdr(),
    recipient.publicKey(),
    MAINNET.passphrase,
  );
  assert.equal(okTx.signatures.length, 1);
  // The same signature is invalid when verified for testnet or against the testnet body.
  assert.throws(() =>
    verifyRecipient(
      m.toXdr(),
      signedMain.toXdr(),
      recipient.publicKey(),
      TESTNET.passphrase,
    ),
  );
  assert.throws(() =>
    verifyRecipient(
      t.toXdr(),
      signedMain.toXdr(),
      recipient.publicKey(),
      TESTNET.passphrase,
    ),
  );
  assert.throws(() =>
    verifyRecipient(t.toXdr(), signedMain.toXdr(), recipient.publicKey()),
  );
  // Fee-bump wrapping is bound to the inner transaction's network.
  const outer = wrap(
    onboarding(input, MAINNET),
    [channel, sponsor],
    payer,
    1000,
    MAINNET.passphrase,
  );
  assert.ok(
    outer.signatures.some((s) => payer.verify(outer.hash(), s.signature)),
  );
  assert.throws(
    () =>
      wrap(
        onboarding(input, MAINNET),
        [channel, sponsor],
        payer,
        1000,
        TESTNET.passphrase,
      ),
    /another network/,
  );
  assert.throws(() =>
    wrap(onboarding(input, MAINNET), [channel, sponsor], payer, 1000),
  );
});

test("mainnet configuration demands explicit acknowledgement, limits, namespace, HTTPS, relay and remote signer", async () => {
  const f = await fixture();
  try {
    const base = f.config;
    // Testnet behaviour is unchanged: the literal mainnet passphrase alone is rejected.
    assert.throws(() => validateConfig({ ...base, network: Networks.PUBLIC }));
    assert.throws(() => validateConfig({ ...base, network: "Custom ; 2026" }));
    assert.throws(
      () => validateConfig({ ...base, mainnet: ack }),
      /non-mainnet/,
    );
    const good = mainnetService(base);
    const c = validateConfig(good);
    assert.equal(c.namespace, "mainnet_" + base.namespace);
    assert.equal(
      validateConfig({ ...good, publicDailyAdmissions: 0 })
        .publicDailyAdmissions,
      0,
    );
    assert.equal(
      validateConfig({ ...good, publicDailyAdmissions: null })
        .publicDailyAdmissions,
      null,
    );
    assert.throws(() => validateConfig({ ...good, publicDailyAdmissions: -1 }));
    const without = (key: string) => {
      const copy = { ...good };
      delete copy[key];
      return copy;
    };
    assert.throws(() => validateConfig(without("mainnet")), /acknowledge/);
    assert.throws(() =>
      validateConfig({ ...good, mainnet: { acknowledge: "yes" } }),
    );
    assert.throws(
      () => validateConfig(without("reserveCeiling")),
      /reserveCeiling/,
    );
    assert.throws(() => validateConfig({ ...good, reserveCeiling: "0" }));
    assert.throws(() => validateConfig({ ...good, reserveCeiling: "1e3" }));
    assert.throws(
      () => validateConfig(without("signerLimits")),
      /signerLimits/,
    );
    assert.throws(() =>
      validateConfig({ ...good, signerLimits: { count: 0, fee: "1" } }),
    );
    assert.throws(() =>
      validateConfig({ ...good, signerLimits: { count: 1, fee: "0" } }),
    );
    assert.throws(() => validateConfig(without("namespace")), /namespace/);
    assert.throws(
      () => validateConfig({ ...good, namespace: "cardea" }),
      /namespace/,
    );
    assert.throws(
      () => validateConfig({ ...good, origin: "http://localhost:4317" }),
      /HTTPS/,
    );
    assert.throws(() => validateConfig(without("relaySecret")), /relaySecret/);
    assert.throws(
      () => validateConfig({ ...without("signerSocket"), keys: base.keys }),
      /remote signer/,
    );
    // Signer role: local keys required, socket forbidden, relaySecret not needed.
    const s = validateConfig(mainnetSigner(base), "signer");
    assert.equal(s.keys.length, base.keys.length);
    assert.throws(() => validateConfig(good, "signer"), /Signer requires/);
    assert.throws(() =>
      validateConfig({ ...mainnetSigner(base), signerSocket: "/x" }, "signer"),
    );
    // Optional ceilings remain usable on testnet; negative or zero values are rejected.
    assert.ok(validateConfig({ ...base, reserveCeiling: "5" }));
    assert.throws(() => validateConfig({ ...base, reserveCeiling: "0" }));
    assert.throws(() => validateConfig({ ...base, reserveCeiling: "-1" }));
  } finally {
    await f.close();
  }
});

test("persistent state binds to one network: legacy data adopts testnet only, mainnet must start empty", async () => {
  const f = await fixture();
  const url = f.config.databaseUrl;
  const legacy = "test_legacy_" + f.config.namespace.slice(5, 20),
    fresh = "test_fresh_" + f.config.namespace.slice(5, 20);
  const stores: Store[] = [];
  const open = (ns: string, network: string) => {
    const s = new Store(url, ns, network);
    stores.push(s);
    return s;
  };
  try {
    assert.equal((await f.store.read()).network, TESTNET.passphrase);
    // Legacy populated row without a network binding (pre-mainnet releases).
    await f.store.db.query("INSERT INTO cardea_state VALUES ($1,$2)", [
      legacy,
      {
        version: 1,
        revision: 7,
        pools: [],
        intents: [],
        sessions: [],
        workerAt: 1,
      },
    ]);
    await assert.rejects(
      open(legacy, MAINNET.passphrase).init(),
      /cannot be adopted by a mainnet installation/,
    );
    const row = await f.store.db.query(
      "SELECT data FROM cardea_state WHERE id=$1",
      [legacy],
    );
    assert.equal(
      row.rows[0].data.network,
      undefined,
      "rejected init writes nothing",
    );
    const adopted = open(legacy, TESTNET.passphrase);
    await adopted.init();
    assert.equal((await adopted.read()).network, TESTNET.passphrase);
    await assert.rejects(
      open(legacy, MAINNET.passphrase).init(),
      /bound to a different network/,
    );
    // Fresh mainnet namespace binds on first init and refuses testnet afterwards.
    const main = open(fresh, MAINNET.passphrase);
    await main.init();
    assert.equal((await main.read()).network, MAINNET.passphrase);
    await main.init(); // idempotent
    await assert.rejects(
      open(fresh, TESTNET.passphrase).init(),
      /bound to a different network/,
    );
    // Service startup refuses a store bound to another network, and mainnet
    // refuses in-process keys even if a config object bypassed validation.
    const mainnetConfig = validateConfig(mainnetService(f.config));
    assert.throws(
      () => new Cardea(f.store, f.chain, mainnetConfig),
      /different network/,
    );
    assert.throws(
      () =>
        new Cardea(main, f.chain, {
          ...mainnetConfig,
          signerSocket: undefined,
          keys: f.config.keys,
        }),
      /remote signer/,
    );
    const app = new Cardea(main, f.chain, mainnetConfig);
    assert.equal(app.networkProfile, MAINNET);
    assert.deepEqual(app.network(), publicProfile(MAINNET));
    assert.throws(() => new Store(url, fresh, "Unknown ; 2026"));
  } finally {
    for (const s of stores) await s.close();
    await f.store.db.query(
      "DELETE FROM cardea_audit WHERE namespace = ANY($1)",
      [[legacy, fresh]],
    );
    await f.store.db.query("DELETE FROM cardea_state WHERE id = ANY($1)", [
      [legacy, fresh],
    ]);
    await f.close();
  }
});

test("remote signer and journal refuse network mismatches; mainnet signer signs only mainnet", async () => {
  const f = await fixture(),
    dir = mkdtempSync(join(tmpdir(), "cardea-mainnet-signer-"));
  const daemons: ReturnType<typeof signerServer>[] = [];
  const listen = (d: ReturnType<typeof signerServer>, socket: string) => {
    daemons.push(d);
    return new Promise<void>((r) => d.listen(socket, r));
  };
  const request = (
    profile: typeof TESTNET,
    n: number,
    network?: string,
  ): SigningRequest => {
    const tx = onboarding(
      {
        channel: f.config.channels[n],
        sequence: "1",
        sponsor: f.config.sponsors[0],
        recipient: f.users[n].publicKey(),
        expires: Math.floor(Date.now() / 1000) + 100,
      },
      profile,
    );
    tx.sign(f.users[n]);
    return {
      kind: "onboard",
      ...(network !== undefined ? { network } : {}),
      sponsor: f.config.sponsors[0],
      recipient: f.users[n].publicKey(),
      channel: f.config.channels[n],
      sequence: tx.sequence,
      expires: Number(tx.timeBounds!.maxTime),
      xdr: tx.toXdr(),
    };
  };
  try {
    // Direct policy checks.
    assert.ok(
      canonicalSigning(request(TESTNET, 0, TESTNET.passphrase), f.config),
    );
    assert.ok(canonicalSigning(request(TESTNET, 0), f.config));
    assert.throws(
      () => canonicalSigning(request(TESTNET, 0, MAINNET.passphrase), f.config),
      /network/,
    );
    assert.throws(() =>
      canonicalSigning(request(MAINNET, 0, TESTNET.passphrase), f.config),
    );
    // Testnet signer over a socket.
    const testSocket = join(dir, "test.sock");
    await listen(signerServer(f.config, join(dir, "test.json")), testSocket);
    const payer = f.config.feePayer;
    await assert.rejects(
      new RemoteSigning(testSocket, NETWORK, payer).sign(
        request(TESTNET, 0, MAINNET.passphrase),
      ),
      /rejected/,
    );
    // A client that believes it is on mainnet must not accept a testnet-signed envelope.
    // Reuse the exact envelope below: rebuilding after a second boundary changes
    // its expiry/hash and correctly triggers the signer's sequence conflict guard.
    const testnetRequest = request(TESTNET, 0, TESTNET.passphrase);
    await assert.rejects(
      new RemoteSigning(testSocket, MAINNET.passphrase, payer).sign(
        testnetRequest,
      ),
      /not signed for this network/,
    );
    const ok = await new RemoteSigning(testSocket, NETWORK, payer).sign(
      testnetRequest,
    );
    assert.equal(ok.innerTransaction.networkPassphrase, TESTNET.passphrase);
    // A journal written by another network's signer is refused at startup.
    const foreign = join(dir, "foreign.json");
    writeFileSync(
      foreign,
      JSON.stringify([
        {
          key: "x:1",
          hash: "00",
          expires: 0,
          day: "2020-01-01",
          fee: "0",
          network: MAINNET.passphrase,
        },
      ]),
    );
    assert.throws(() => signerServer(f.config, foreign), /another network/);
    // Mainnet signer: explicit limits from its own config, unbound legacy journal refused.
    const signerConfig = validateConfig(mainnetSigner(f.config), "signer");
    assert.deepEqual(signerLimitsOf(signerConfig), {
      count: 50,
      fee: units("1").toString(),
      maintenanceReserve: 10,
    });
    assert.deepEqual(signerLimitsOf(f.config), {
      count: 100,
      fee: "10000000",
      maintenanceReserve: 20,
    });
    const legacyJournal = join(dir, "legacy.json");
    writeFileSync(
      legacyJournal,
      JSON.stringify([
        { key: "x:1", hash: "00", expires: 0, day: "2020-01-01", fee: "0" },
      ]),
    );
    assert.throws(
      () => signerServer(signerConfig, legacyJournal),
      /another network/,
    );
    const mainJournal = join(dir, "main.json");
    assert.throws(
      () => signerServer(signerConfig, mainJournal),
      /journal missing/,
    );
    writeFileSync(mainJournal, "[]", { mode: 0o600 });
    const mainSocket = join(dir, "main.sock");
    await listen(signerServer(signerConfig, mainJournal), mainSocket);
    // Requests without an explicit network, or for testnet, are refused on mainnet.
    await assert.rejects(
      new RemoteSigning(mainSocket, MAINNET.passphrase, payer).sign(
        request(MAINNET, 1),
      ),
    );
    await assert.rejects(
      new RemoteSigning(mainSocket, MAINNET.passphrase, payer).sign(
        request(TESTNET, 1, TESTNET.passphrase),
      ),
    );
    const signed = await new RemoteSigning(
      mainSocket,
      MAINNET.passphrase,
      payer,
    ).sign(request(MAINNET, 1, MAINNET.passphrase));
    assert.equal(signed.innerTransaction.networkPassphrase, MAINNET.passphrase);
    assert.ok(
      signed.signatures.some((s) =>
        Keypair.fromPublicKey(payer).verify(signed.hash(), s.signature),
      ),
    );
    unlinkSync(mainJournal);
    await assert.rejects(
      new RemoteSigning(mainSocket, MAINNET.passphrase, payer).sign(
        request(MAINNET, 0, MAINNET.passphrase),
      ),
      /rejected/,
    );
    // Maintenance reserve leaves capacity for one onboarding signature.
    const tight = validateConfig(
      {
        ...mainnetSigner(f.config),
        signerLimits: { count: 2, fee: "1", maintenanceReserve: 1 },
      },
      "signer",
    );
    const tightSocket = join(dir, "tight.sock");
    writeFileSync(join(dir, "tight.json"), "[]", { mode: 0o600 });
    await listen(signerServer(tight, join(dir, "tight.json")), tightSocket);
    const tightClient = new RemoteSigning(
      tightSocket,
      MAINNET.passphrase,
      payer,
    );
    await tightClient.sign(request(MAINNET, 2, MAINNET.passphrase));
    await assert.rejects(
      tightClient.sign(request(MAINNET, 3, MAINNET.passphrase)),
    );
    // The reserved second signature must still be usable by maintenance.
    const upkeep = maintenance(
      {
        channel: f.config.channels[4],
        sequence: "1",
        sponsor: f.config.sponsors[0],
        recipient: f.users[4].publicKey(),
        expires: Math.floor(Date.now() / 1000) + 100,
      },
      undefined,
      { account: true, trustline: true },
      MAINNET,
    );
    await tightClient.sign({
      kind: "graduate",
      network: MAINNET.passphrase,
      sponsor: f.config.sponsors[0],
      recipient: f.users[4].publicKey(),
      channel: f.config.channels[4],
      sequence: upkeep.sequence,
      expires: Number(upkeep.timeBounds!.maxTime),
      entries: { account: true, trustline: true },
      xdr: upkeep.toXdr(),
    });
  } finally {
    for (const d of daemons) await new Promise<void>((r) => d.close(() => r()));
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signer rejects an envelope valid at the next UTC budget boundary", async () => {
  const f = await fixture();
  const boundary = (Math.floor(Date.now() / 86400000) + 1) * 86400;
  const clock = mock.method(Date, "now", () => (boundary - 20) * 1000);
  try {
    const c = validateConfig(mainnetSigner(f.config), "signer");
    const make = (expires: number): SigningRequest => {
      const tx = onboarding(
        {
          channel: f.config.channels[0],
          sequence: "1",
          sponsor: f.config.sponsors[0],
          recipient: f.users[0].publicKey(),
          expires,
        },
        MAINNET,
      );
      tx.sign(f.users[0]);
      return {
        kind: "onboard",
        network: MAINNET.passphrase,
        sponsor: f.config.sponsors[0],
        recipient: f.users[0].publicKey(),
        channel: f.config.channels[0],
        sequence: tx.sequence,
        expires,
        xdr: tx.toXdr(),
      };
    };
    assert.ok(canonicalSigning(make(boundary - 1), c));
    assert.throws(() => canonicalSigning(make(boundary), c), /validity/);
  } finally {
    clock.mock.restore();
    await f.close();
  }
});

test("installation reserve ceiling counts committed and pending reserve across all pools", async () => {
  const f = await fixture();
  try {
    f.config.reserveCeiling = "2";
    const first = await f.prepare(0);
    assert.ok(first.id);
    await assert.rejects(f.prepare(1), /Installation reserve ceiling/);
    f.config.reserveCeiling = "3";
    const second = await f.prepare(1);
    assert.ok(second.id);
    await f.sign(first, 0);
    await f.land();
    // Confirmed sponsorship (1.5 XLM) plus pending (1.5 XLM) still fills a 3 XLM ceiling.
    await assert.rejects(f.prepare(2), /Installation reserve ceiling/);
    const dashboard = await f.app.dashboard();
    assert.equal(dashboard.reserveCeiling, units("3").toString());
    assert.equal(dashboard.committedReserve, units("3").toString());
    assert.equal(dashboard.networkName, "testnet");
    assert.equal(dashboard.friendbot, TESTNET.friendbot);
    delete f.config.reserveCeiling;
    assert.ok((await f.prepare(2)).id);
  } finally {
    await f.close();
  }
});

test("public network metadata route exposes only the profile and health names the network", async () => {
  const f = await fixture();
  const http = await server(f.app);
  try {
    const r = await http.inject({ url: "/api/onboarding/network" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.deepEqual(r.json(), publicProfile(TESTNET));
    assert.deepEqual(r.json(), {
      name: "testnet",
      passphrase: TESTNET.passphrase,
      horizon: TESTNET.horizon,
      issuer: TESTNET.issuer,
      explorer: TESTNET.explorer,
      friendbot: TESTNET.friendbot,
    });
    const h = await http.inject({ url: "/api/health" });
    assert.equal(h.json().network, "testnet");
    const post = await http.inject({
      method: "POST",
      url: "/api/onboarding/network",
      headers: { origin: f.config.origin },
    });
    assert.notEqual(post.statusCode, 200, "metadata route is read-only");
    const prepared = await f.prepare();
    assert.equal(prepared.network, TESTNET.passphrase);
  } finally {
    await http.close();
    await f.close();
  }
});

test("browser network helpers fail closed on unknown or mixed metadata and render per profile", () => {
  const t = parseNetworkInfo(publicProfile(TESTNET)),
    m = parseNetworkInfo(publicProfile(MAINNET));
  assert.equal(t.name, "testnet");
  assert.equal(m.name, "mainnet");
  for (const bad of [
    null,
    "mainnet",
    {},
    { ...publicProfile(MAINNET), name: "public" },
    { ...publicProfile(MAINNET), issuer: TESTNET.issuer },
    { ...publicProfile(MAINNET), friendbot: TESTNET.friendbot },
    { ...publicProfile(TESTNET), passphrase: MAINNET.passphrase },
    { ...publicProfile(TESTNET), explorer: "http://stellar.expert/x" },
    { ...publicProfile(MAINNET), horizon: TESTNET.horizon },
  ])
    assert.throws(() => parseNetworkInfo(bad));
  assert.equal(
    explorerLink(m, "tx", "ab"),
    "https://stellar.expert/explorer/public/tx/ab",
  );
  assert.equal(
    explorerLink(t, "account", "GABC"),
    "https://stellar.expert/explorer/testnet/account/GABC",
  );
  assert.equal(friendbotLink(m, "GABC"), null);
  assert.equal(
    friendbotLink(t, "GABC"),
    "https://friendbot.stellar.org?addr=GABC",
  );
  assert.equal(networkLabel(m), "Stellar mainnet");
  assert.equal(networkLabel(t), "Stellar testnet");
  assert.equal(networkLabel(null), "Network unavailable");
  assert.equal(networkBadge(m), "STELLAR MAINNET");
  assert.equal(networkBadge(null), "NETWORK UNAVAILABLE");
  const real = "Real XLM reserves. Sponsorship covers reserves and fees only.";
  const test = "Test assets only. No real funds.";
  assert.equal(networkSpecificCopy(m, real, test), real);
  assert.equal(networkSpecificCopy(t, real, test), test);
  assert.equal(
    networkSpecificCopy(null, real, test),
    "Network information unavailable. Reload the page and try again.",
  );
});
