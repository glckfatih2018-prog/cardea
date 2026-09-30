import {
  Keypair,
  TransactionBuilder,
  FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { validateConfig, passwordHash } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { Cardea } from "../src/service.ts";
import {
  NETWORK,
  ISSUER,
  hex,
  units,
  xlm,
  type Chain,
  type ChainAccount,
  type ChainResult,
  type NetworkSnapshot,
} from "../src/stellar.ts";
export class FakeChain implements Chain {
  accounts = new Map<string, ChainAccount>();
  results = new Map<string, ChainResult>();
  submissions: string[] = [];
  failSubmit = false;
  unknownSubmit = false;
  stale = false;
  ledger = 100;
  closedAt = Math.floor(Date.now() / 1000);
  async snapshot(): Promise<NetworkSnapshot> {
    if (this.stale) throw new Error("Stale ledger");
    return {
      ledger: this.ledger,
      closedAt: this.closedAt,
      reserve: "5000000",
      baseFee: 100,
    };
  }
  async account(id: string) {
    return structuredClone(this.accounts.get(id) ?? null);
  }
  async accountWithLedger(id: string) {
    return { account: await this.account(id), ledger: this.ledger };
  }
  /**
   * Horizon semantics: a lookup by the inner hash of a fee-bumped transaction
   * resolves too, with the top-level hash equal to the INNER hash, the outer
   * hash under fee_bump_transaction and the payer under fee_account.
   */
  async result(hash: string) {
    const direct = this.results.get(hash);
    if (direct) return direct;
    for (const r of this.results.values()) {
      try {
        const outer = TransactionBuilder.fromXdr(r.envelope_xdr, NETWORK);
        if (
          outer instanceof FeeBumpTransaction &&
          hex(outer.innerTransaction.hash()) === hash
        )
          return {
            ...r,
            hash,
            inner_transaction: { hash },
            fee_bump_transaction: { hash: r.hash },
            fee_account: outer.feeSource,
          };
      } catch {}
    }
    return null;
  }
  async submit(xdr: string) {
    this.submissions.push(xdr);
    if (this.failSubmit) throw new Error("timeout before inclusion");
    if (this.unknownSubmit) return;
    const outer = TransactionBuilder.fromXdr(xdr, NETWORK);
    if (!(outer instanceof FeeBumpTransaction))
      throw new Error("fee bump required");
    const hash = hex(outer.hash());
    if (this.results.has(hash)) return;
    const tx = outer.innerTransaction;
    const channel = this.accounts.get(tx.source)!;
    channel.sequence = tx.sequence;
    let target: string | undefined;
    for (const op of tx.operations as any[]) {
      if (op.type === "beginSponsoringFutureReserves") target = op.source;
      if (op.type === "createAccount") {
        this.accounts.set(op.destination, {
          account_id: op.destination,
          sequence: "0",
          balances: [{ asset_type: "native", balance: "0.0000000" }],
          num_sponsored: 2,
          num_sponsoring: 0,
          subentry_count: 0,
          sponsor: op.source,
          signers: [{ key: op.destination, weight: 1 }],
        });
        this.accounts.get(op.source)!.num_sponsoring += 2;
      }
      if (op.type === "changeTrust") {
        const a = this.accounts.get(op.source)!;
        a.subentry_count++;
        a.num_sponsored++;
        a.balances.push({
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: ISSUER,
          balance: "0.0000000",
          sponsor: target,
        });
        this.accounts.get(target!)!.num_sponsoring++;
      }
      if (
        op.type === "revokeAccountSponsorship" ||
        op.type === "revokeTrustlineSponsorship"
      ) {
        const a = this.accounts.get(op.account)!;
        const amount = op.type === "revokeAccountSponsorship" ? 2 : 1;
        this.accounts.get(op.source)!.num_sponsoring -= amount;
        if (target) this.accounts.get(target)!.num_sponsoring += amount;
        else a.num_sponsored -= amount;
        if (amount === 2) a.sponsor = target;
        else a.balances.find((b) => b.asset_code === "USDC")!.sponsor = target;
      }
    }
    const payer = this.accounts.get(outer.feeSource)!.balances[0];
    payer.balance = xlm(units(payer.balance) - BigInt(outer.fee));
    this.ledger++;
    this.results.set(hash, {
      hash,
      created_at: new Date().toISOString(),
      successful: true,
      ledger: this.ledger,
      fee_charged: outer.fee,
      result_xdr: "fake-only",
      envelope_xdr: xdr,
    });
  }
}
export async function fixture(options: { autoGraduate?: boolean } = {}) {
  const roles = Array.from({ length: 13 }, () => Keypair.random());
  const keys = roles.map((k) => k.secret());
  const config = validateConfig({
    network: NETWORK,
    databaseUrl:
      process.env.TEST_DATABASE_URL ??
      JSON.parse(readFileSync(".local/config.json", "utf8")).databaseUrl,
    namespace: "test_" + randomUUID().replaceAll("-", ""),
    origin: "http://localhost:4317",
    operatorHash: passwordHash("test-operator-password-long"),
    keys,
    sponsors: roles.slice(0, 2).map((k) => k.publicKey()),
    channels: roles.slice(3).map((k) => k.publicKey()),
    feePayer: roles[2].publicKey(),
    baseFee: 1000,
    autoGraduate: options.autoGraduate ?? false,
  });
  const chain = new FakeChain();
  for (const k of roles)
    chain.accounts.set(k.publicKey(), {
      account_id: k.publicKey(),
      sequence: "1",
      balances: [
        {
          asset_type: "native",
          balance: "1000.0000000",
          selling_liabilities: "0",
        },
      ],
      num_sponsoring: 0,
      num_sponsored: 0,
      subentry_count: 0,
      signers: [{ key: k.publicKey(), weight: 1 }],
    });
  const store = new Store(config.databaseUrl, config.namespace);
  await store.init();
  const app = new Cardea(store, chain, config);
  await app.tick();
  const p = await app.createPool("Test", config.sponsors[0], "100", "1");
  const users = Array.from({ length: 50 }, () => Keypair.random());
  await app.allowlist(
    p.id,
    users.map((u) => u.publicKey()),
  );
  await app.policy(p.id, true);
  async function prepare(n = 0) {
    return app.prepare(
      app.invitation(p, users[n].publicKey()),
      users[n].publicKey(),
    );
  }
  let clients = 0;
  /** Synthetic trusted client identity; production always supplies the relay/socket identity. */
  const client = () => "203.0.113." + ++clients;
  /** Public (invitation-free) preparation from a fresh synthetic client unless one is given. */
  async function publicPrepare(recipient: string, pool = p.id, id = client()) {
    return app.prepare("", recipient, pool, id);
  }
  async function sign(r: Awaited<ReturnType<typeof prepare>>, n = 0) {
    const tx = TransactionBuilder.fromXdr(r.xdr, NETWORK);
    tx.sign(users[n]);
    return app.submit(r.id, r.token, tx.toXdr());
  }
  async function land() {
    await app.tick();
    await app.tick();
  }
  async function close() {
    await store.db.query("DELETE FROM cardea_audit WHERE namespace=$1", [
      config.namespace,
    ]);
    await store.db.query("DELETE FROM cardea_state WHERE id=$1", [
      config.namespace,
    ]);
    await store.close();
  }
  return {
    app,
    store,
    chain,
    config,
    p,
    users,
    prepare,
    publicPrepare,
    client,
    sign,
    land,
    close,
  };
}
