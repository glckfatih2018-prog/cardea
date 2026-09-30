import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { timingSafeEqual } from "node:crypto";
import { TESTNET, type NetworkProfile, usdc } from "./network.ts";
// Testnet compatibility constants. Production paths (service, signer, chain)
// receive the resolved profile explicitly; these are only the defaults used by
// local fixtures and the testnet harness.
export const NETWORK: string = Networks.TESTNET;
export const HORIZON = TESTNET.horizon;
export const ISSUER = TESTNET.issuer;
export const USDC = new Asset("USDC", ISSUER);
export const TRUST_LIMIT = "922337203685.4775807";
export function units(value: string): bigint {
  if (!/^\d+(\.\d{1,7})?$/.test(value)) throw new Error("Invalid XLM amount");
  const [a, b = ""] = value.split(".");
  return BigInt(a) * 10000000n + BigInt(b.padEnd(7, "0"));
}
export function xlm(v: bigint): string {
  return `${v / 10000000n}.${(v % 10000000n).toString().padStart(7, "0")}`;
}
export function address(value: string): string {
  Keypair.fromPublicKey(value);
  return value;
}
export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
export type BuildInput = {
  channel: string;
  sequence: string;
  sponsor: string;
  recipient: string;
  expires: number;
  trustlineOnly?: boolean;
};
export function onboarding(
  i: BuildInput,
  profile: NetworkProfile = TESTNET,
): Transaction {
  let builder = new TransactionBuilder(new Account(i.channel, i.sequence), {
    fee: "0",
    networkPassphrase: profile.passphrase,
  }).addOperation(
    Operation.beginSponsoringFutureReserves({
      source: i.sponsor,
      sponsoredId: i.recipient,
    }),
  );
  if (!i.trustlineOnly)
    builder = builder.addOperation(
      Operation.createAccount({
        source: i.sponsor,
        destination: i.recipient,
        startingBalance: "0",
      }),
    );
  return builder
    .addOperation(
      Operation.changeTrust({
        source: i.recipient,
        asset: usdc(profile),
        limit: TRUST_LIMIT,
      }),
    )
    .addOperation(
      Operation.endSponsoringFutureReserves({ source: i.recipient }),
    )
    .setTimebounds(0, i.expires)
    .build();
}
export function maintenance(
  i: BuildInput,
  target?: string,
  entries: { account: boolean; trustline: boolean } = {
    account: true,
    trustline: true,
  },
  profile: NetworkProfile = TESTNET,
): Transaction {
  let b = new TransactionBuilder(new Account(i.channel, i.sequence), {
    fee: "0",
    networkPassphrase: profile.passphrase,
  });
  if (target)
    b = b.addOperation(
      Operation.beginSponsoringFutureReserves({
        source: target,
        sponsoredId: i.sponsor,
      }),
    );
  if (entries.trustline)
    b = b.addOperation(
      Operation.revokeTrustlineSponsorship({
        source: i.sponsor,
        account: i.recipient,
        asset: usdc(profile),
      }),
    );
  if (entries.account)
    b = b.addOperation(
      Operation.revokeAccountSponsorship({
        source: i.sponsor,
        account: i.recipient,
      }),
    );
  if (target)
    b = b.addOperation(
      Operation.endSponsoringFutureReserves({ source: i.sponsor }),
    );
  return b.setTimebounds(0, i.expires).build();
}
export function verifyRecipient(
  expected: string,
  returned: string,
  recipient: string,
  passphrase: string = NETWORK,
): Transaction {
  if (returned.length > 20000) throw new Error("Envelope too large");
  // The passphrase is part of the signature base: a signature produced for
  // another network fails verification here even if the body is identical.
  const base = TransactionBuilder.fromXdr(expected, passphrase),
    tx = TransactionBuilder.fromXdr(returned, passphrase);
  if (
    !(base instanceof Transaction) ||
    !(tx instanceof Transaction) ||
    base.signatures.length
  )
    throw new Error("Invalid envelope type");
  const a = Buffer.from(base.signatureBase()),
    b = Buffer.from(tx.signatureBase());
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new Error("Transaction was modified");
  if (
    tx.signatures.length !== 1 ||
    !Keypair.fromPublicKey(recipient).verify(
      base.hash(),
      tx.signatures[0].signature,
    )
  )
    throw new Error("Invalid recipient signature");
  // Validate decoration too: Stellar uses the hint to select its verifying key.
  const expectedHint = Keypair.fromPublicKey(recipient).signatureHint();
  if (
    !Buffer.from(tx.signatures[0].hint.value).equals(Buffer.from(expectedHint))
  )
    throw new Error("Invalid signature hint");
  base.addDecoratedSignature(tx.signatures[0]);
  return base;
}
export function wrap(
  tx: Transaction,
  signers: Keypair[],
  payer: Keypair,
  baseFee: number,
  passphrase: string = NETWORK,
) {
  if (!Number.isSafeInteger(baseFee) || baseFee < 100 || baseFee > 10000)
    throw new Error("Fee outside policy");
  if (tx.networkPassphrase !== passphrase)
    throw new Error("Inner transaction built for another network");
  for (const signer of new Map(signers.map((s) => [s.publicKey(), s])).values())
    tx.sign(signer);
  const outer = TransactionBuilder.buildFeeBumpTransaction(
    payer,
    String(baseFee),
    tx,
    passphrase,
  );
  outer.sign(payer);
  return outer;
}
export type Balance = {
  asset_type: string;
  balance: string;
  selling_liabilities?: string;
  asset_code?: string;
  asset_issuer?: string;
  sponsor?: string;
};
export type ChainAccount = {
  account_id: string;
  sequence: string;
  num_sponsoring: number;
  num_sponsored: number;
  subentry_count: number;
  balances: Balance[];
  sponsor?: string;
  signers: { key: string; weight: number }[];
  thresholds?: Record<string, number>;
};
export function native(a: ChainAccount) {
  const n = a.balances.find((b) => b.asset_type === "native");
  if (!n) throw new Error("Native balance missing");
  return n;
}
export function available(
  a: ChainAccount,
  reserve: bigint,
  removedUnits = 0,
): bigint {
  const n = native(a);
  const minimum =
    BigInt(
      2 + a.subentry_count + a.num_sponsoring - a.num_sponsored + removedUnits,
    ) * reserve;
  return units(n.balance) - units(n.selling_liabilities ?? "0") - minimum;
}
export function sponsored(
  a: ChainAccount,
  sponsor: string,
  issuer: string = ISSUER,
) {
  const t = a.balances.find(
    (b) => b.asset_code === "USDC" && b.asset_issuer === issuer,
  );
  const account = a.sponsor === sponsor,
    trustline = t?.sponsor === sponsor;
  return { account, trustline, units: (account ? 2 : 0) + (trustline ? 1 : 0) };
}
export type NetworkSnapshot = {
  ledger: number;
  closedAt: number;
  reserve: string;
  baseFee: number;
};
export type ChainResult = {
  /**
   * Horizon's top-level hash is the hash that was queried: for a lookup by
   * inner hash of a fee-bumped transaction it is the INNER hash, not the outer.
   */
  hash: string;
  created_at?: string;
  successful: boolean;
  ledger: number;
  fee_charged: string;
  result_xdr: string;
  envelope_xdr: string;
  fee_account?: string;
  inner_transaction?: { hash: string };
  fee_bump_transaction?: { hash: string };
};
export interface Chain {
  snapshot(): Promise<NetworkSnapshot>;
  account(id: string): Promise<ChainAccount | null>;
  accountWithLedger(
    id: string,
  ): Promise<{ account: ChainAccount | null; ledger: number | null }>;
  result(hash: string): Promise<ChainResult | null>;
  submit(xdr: string): Promise<void>;
}
/** Horizon client bound to one immutable profile; the endpoint is never configurable. */
export class HorizonChain implements Chain {
  constructor(readonly profile: NetworkProfile) {}
  private async request(path: string, init?: RequestInit) {
    const r = await fetch(this.profile.horizon + path, {
      ...init,
      signal: AbortSignal.timeout(12000),
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Horizon ${r.status}`);
    return r.json();
  }
  async snapshot(): Promise<NetworkSnapshot> {
    const root = await this.request("");
    if (root.network_passphrase !== this.profile.passphrase)
      throw new Error("Wrong network");
    const p = await this.request("/ledgers?order=desc&limit=1");
    const l = p._embedded.records[0];
    const closedAt = Date.parse(l.closed_at) / 1000;
    if (Date.now() / 1000 - closedAt > 90) throw new Error("Stale ledger");
    return {
      ledger: l.sequence,
      closedAt,
      reserve: String(l.base_reserve_in_stroops),
      baseFee: l.base_fee_in_stroops,
    };
  }
  account(id: string) {
    address(id);
    return this.request("/accounts/" + id) as Promise<ChainAccount | null>;
  }
  async accountWithLedger(id: string) {
    address(id);
    const response = await fetch(this.profile.horizon + "/accounts/" + id, {
      signal: AbortSignal.timeout(12000),
    });
    if (response.status !== 404 && !response.ok)
      throw new Error(`Horizon ${response.status}`);
    const header = response.headers.get("Latest-Ledger");
    const ledger = header && /^\d+$/.test(header) ? Number(header) : null;
    return {
      account:
        response.status === 404
          ? null
          : ((await response.json()) as ChainAccount),
      ledger: ledger !== null && Number.isSafeInteger(ledger) ? ledger : null,
    };
  }
  result(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid hash");
    return this.request("/transactions/" + hash) as Promise<ChainResult | null>;
  }
  async submit(envelope: string) {
    // Errors are ambiguous until reconciliation; never derive failure solely from HTTP.
    await this.request("/transactions", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tx: envelope }).toString(),
    });
  }
}
/** Testnet-only client for local scripts and the acceptance harness. */
export class TestnetChain extends HorizonChain {
  constructor() {
    super(TESTNET);
  }
}
