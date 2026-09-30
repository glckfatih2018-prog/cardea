import type { State } from "./model.ts";
import { pending, signed } from "./model.ts";
import type { ChainAccount } from "./stellar.ts";
import { available, units, xlm } from "./stellar.ts";

export type PreflightCheck = { name: string; ok: boolean; detail: string };

/** A missing/old state is not evidence that the installation is ready. */
export function assessState(
  state: State | undefined,
  passphrase: string,
  reserve: bigint,
  ceiling: string,
  at: number,
): PreflightCheck[] {
  const c = (name: string, ok: boolean, detail: string): PreflightCheck => ({
    name,
    ok,
    detail,
  });
  if (!state)
    return [c("state.initialized", false, "Start the service and worker first")];
  const signedCount = state.intents.filter(signed).length;
  const committed =
    state.pools
      .flatMap((p) => p.sponsorships)
      .reduce((sum, r) => sum + BigInt(r.units) * reserve, 0n) +
    state.intents
      .filter((i) => pending(i) && i.kind === "onboard")
      .reduce((sum, i) => sum + BigInt(i.cost), 0n);
  const sponsorOwners = new Map<string, string>();
  let isolated = true;
  const claim = (sponsor: string | undefined, pool: string) => {
    if (!sponsor) return;
    const owner = sponsorOwners.get(sponsor);
    if (owner && owner !== pool) isolated = false;
    else sponsorOwners.set(sponsor, pool);
  };
  for (const pool of state.pools) {
    claim(pool.sponsor, pool.id);
    for (const record of pool.sponsorships) claim(record.sponsor, pool.id);
  }
  for (const intent of state.intents) {
    claim(intent.sponsor, intent.pool);
    claim(intent.target, intent.pool);
  }
  return [
    c("state.network", state.network === passphrase, state.network ?? "unbound"),
    c("state.halted", !state.haltReason, state.haltReason ?? "not halted"),
    c("state.worker", at - state.workerAt >= 0 && at - state.workerAt < 90,
      `last heartbeat ${at - state.workerAt}s ago`),
    c("state.monitor", state.monitorAt !== undefined && at - state.monitorAt >= 0 && at - state.monitorAt < 90,
      `last coherent monitor ${state.monitorAt === undefined ? "missing" : `${at - state.monitorAt}s ago`}`),
    c("state.snapshot", !!state.snapshot && at - state.snapshot.closedAt >= 0 && at - state.snapshot.closedAt < 90,
      `last ledger ${state.snapshot?.ledger ?? "missing"}`),
    c("state.signedPending", signedCount === 0,
      `${signedCount} signed envelopes still in flight`),
    c("state.reserveCeiling", committed <= units(ceiling),
      `${committed} stroops committed or reserved; ceiling ${units(ceiling)} stroops`),
    c("state.sponsorIsolation", isolated,
      isolated ? "each sponsor account belongs to one pool" : "a sponsor account is assigned to multiple pools"),
  ];
}

/** Requires an on-chain role key with enough weight to authorize transactions. */
export function assessRoleAccount(
  label: string,
  key: string,
  account: ChainAccount | null,
  reserve: bigint,
  minimum: bigint,
  expectedSponsoring?: number,
): PreflightCheck[] {
  const prefix = `account.${label}.${key}`;
  if (!account)
    return [{ name: prefix, ok: false, detail: "account missing" }];
  const weight = account.signers.find((s) => s.key === key)?.weight ?? 0;
  const threshold = account.thresholds?.med_threshold;
  const balance = available(account, reserve);
  return [
    { name: `${prefix}.signer`, ok: Number.isInteger(threshold) && threshold! > 0 && weight >= threshold!,
      detail: `key weight ${weight}; medium threshold ${threshold ?? "missing"}` },
    { name: `${prefix}.exclusiveSigner`,
      ok: account.signers.every((s) => s.key === key || s.weight === 0),
      detail: account.signers.some((s) => s.key !== key && s.weight > 0)
        ? "unexpected signer with nonzero weight"
        : "no other signer with nonzero weight" },
    { name: `${prefix}.balance`, ok: balance >= minimum,
      detail: `available ${balance} stroops; minimum ${minimum} stroops` },
    ...(expectedSponsoring === undefined ? [] : [{
      name: `${prefix}.sponsoring`,
      ok: account.num_sponsoring === expectedSponsoring,
      detail: `ledger ${account.num_sponsoring}; persisted ${expectedSponsoring}`,
    }]),
  ];
}

/** A role account must be observed at least as recently as the final ledger read. */
export function assessRoleLedger(
  label: string,
  key: string,
  observed: number | null,
  required: number,
): PreflightCheck {
  return {
    name: `account.${label}.${key}.ledger`,
    ok: observed !== null && Number.isSafeInteger(observed) && observed >= required,
    detail: `account ledger ${observed ?? "missing"}; required ${required}`,
  };
}

/**
 * A configured installation ceiling is only usable when the dedicated
 * sponsors can actually cover it. Count reserve already locked by this
 * installation once, and require liquid sponsor capacity for the rest.
 * This is an aggregate check; per-pool sponsor capacity is checked by the
 * application when a pool is activated and each transaction is prepared.
 */
export function assessSponsorFunding(
  accounts: ChainAccount[],
  expectedCount: number,
  state: State | undefined,
  reserve: bigint,
  ceiling: string,
): PreflightCheck {
  if (!state || accounts.length !== expectedCount)
    return {
      name: "funding.installation",
      ok: false,
      detail: "Fresh state and every configured sponsor account are required",
    };
  const committed = state.pools
    .flatMap((pool) => pool.sponsorships)
    .reduce((sum, record) => sum + BigInt(record.units) * reserve, 0n);
  const liquid = accounts.reduce((sum, account) => sum + available(account, reserve), 0n);
  const target = units(ceiling) - committed;
  const show = (value: bigint) => value < 0n ? `-${xlm(-value)}` : xlm(value);
  return {
    name: "funding.installation",
    ok: target >= 0n && liquid >= target,
    detail: `liquid sponsor capacity ${show(liquid)} XLM; required ${show(target)} XLM beyond ${xlm(committed)} XLM already committed`,
  };
}
