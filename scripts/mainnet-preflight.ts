/**
 * Read-only mainnet preflight. Validates the configuration for the chosen
 * role, inspects the persisted state binding, checks the signer socket, and
 * reads Horizon for network identity, ledger freshness, role accounts and
 * balances. It never signs, never submits, never writes to the database and
 * never creates keys or configuration.
 *
 *   CARDEA_CONFIG=/etc/cardea/config.json npm run preflight:mainnet
 *   CARDEA_CONFIG=/etc/cardea-signer/config.json npm run preflight:mainnet -- signer
 *   ... -- --offline        skip Horizon reads
 *
 * Exit code 0 means every check passed. Passing preflight is necessary, not
 * sufficient: it cannot prove key custody, backup drills or relay deployment.
 */
import { statSync } from "node:fs";
import pg from "pg";
import {
  loadConfig,
  networkOf,
  type Config,
  type ConfigRole,
} from "../src/config.ts";
import { HorizonChain, xlm } from "../src/stellar.ts";
import { signerLimitsOf } from "../src/signer-server.ts";
import type { State } from "../src/model.ts";
import { assessRoleAccount, assessRoleLedger, assessSponsorFunding, assessState } from "../src/preflight.ts";
import type { ChainAccount } from "../src/stellar.ts";
type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = "") =>
  checks.push({ name, ok, detail });
const args = process.argv.slice(2);
const role: ConfigRole = args.includes("signer") ? "signer" : "service";
const offline = args.includes("--offline");
async function main() {
  let config: Config;
  let state: State | undefined;
  try {
    config = loadConfig(role);
    check("config.valid", true, `role ${role}`);
  } catch (e) {
    check("config.valid", false, (e as Error).message);
    return;
  }
  const profile = networkOf(config);
  check(
    "network.mainnet",
    profile.name === "mainnet",
    `configured profile: ${profile.name}`,
  );
  if (profile.name !== "mainnet") return;
  check("network.horizon", true, profile.horizon);
  check("network.issuer", true, profile.issuer);
  check(
    "config.acknowledgement",
    !!config.mainnet,
    config.mainnet ? "present" : "missing",
  );
  check(
    "config.reserveCeiling",
    config.reserveCeiling !== undefined,
    config.reserveCeiling ?? "missing",
  );
  try {
    const limits = signerLimitsOf(config);
    check(
      "config.signerLimits",
      !!config.signerLimits,
      `count ${limits.count}, fee ${xlm(BigInt(limits.fee))} XLM/day`,
    );
  } catch (e) {
    check("config.signerLimits", false, (e as Error).message);
  }
  check(
    "config.namespace",
    config.namespace !== "cardea",
    config.namespace,
  );
  check(
    "config.origin",
    config.origin.startsWith("https://"),
    config.origin,
  );
  check(
    "config.baseFee",
    true,
    `${config.baseFee} stroops/op; onboarding worst case ${config.baseFee * 5} stroops; requests expire after at most 180 s if not included`,
  );
  if (role === "service") {
    check(
      "service.remoteSigner",
      !!config.signerSocket && config.keys.length === 0,
      config.signerSocket ?? "no signerSocket",
    );
    check("service.relaySecret", !!config.relaySecret);
    if (config.signerSocket) {
      try {
        const st = statSync(config.signerSocket);
        check("signer.socket", st.isSocket(), config.signerSocket);
      } catch (e) {
        check("signer.socket", false, (e as Error).message);
      }
    }
    // Database: read the bound state without creating or mutating rows.
    const db = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    try {
      const r = await db.query("SELECT data FROM cardea_state WHERE id=$1", [
        config.namespace,
      ]);
      state = r.rows[0]?.data as State | undefined;
      checks.push(...assessState(state, profile.passphrase,
        BigInt(state?.snapshot?.reserve ?? "5000000"),
        config.reserveCeiling!, Math.floor(Date.now() / 1000)));
    } catch (e) {
      check("state.readable", false, (e as Error).message);
    } finally {
      await db.end();
    }
  } else {
    check("signer.localKeys", config.keys.length > 0 && !config.signerSocket);
  }
  if (offline) {
    check("horizon.skipped", false, "--offline cannot establish mainnet readiness");
    return;
  }
  const chain = new HorizonChain(profile);
  let snap;
  try {
    snap = await chain.snapshot();
    check(
      "horizon.network",
      true,
      `passphrase verified; ledger ${snap.ledger}, base reserve ${xlm(BigInt(snap.reserve))} XLM, base fee ${snap.baseFee}`,
    );
    check(
      "horizon.feePolicy",
      snap.baseFee <= config.baseFee,
      `ledger base fee ${snap.baseFee} <= configured ${config.baseFee}`,
    );
  } catch (e) {
    check("horizon.network", false, (e as Error).message);
    return;
  }
  const reserve = BigInt(snap.reserve);
  const sponsorAccounts: ChainAccount[] = [];
  const roles = [
    ...config.sponsors.map(
      (a) => ["sponsor", a, 3n * reserve] as const,
    ),
    ["feePayer", config.feePayer, BigInt(config.baseFee * 5)] as const,
    ...config.channels.map((a) => ["channel", a, 0n] as const),
  ];
  // Read roles together to reduce the chance of crossing a ledger close.
  // Each response is tagged with Horizon's Latest-Ledger header.
  const observations = await Promise.all(roles.map(async ([label, id, minimum]) => {
    try {
      return { label, id, minimum, reading: await chain.accountWithLedger(id) };
    } catch (error) {
      return { label, id, minimum, error: (error as Error).message };
    }
  }));
  let endLedger: number;
  try {
    endLedger = (await chain.snapshot()).ledger;
    check("horizon.ledgerProgress", endLedger >= snap.ledger,
      `start ${snap.ledger}; end ${endLedger}`);
  } catch (error) {
    check("horizon.ledgerProgress", false, (error as Error).message);
    return;
  }
  for (const { label, id, minimum, reading, error } of observations) {
    if (error) {
      check(`account.${label}`, false, `${id}: ${error}`);
      continue;
    }
    checks.push(assessRoleLedger(label, id, reading!.ledger, endLedger));
    const acc = reading!.account;
    try {
      if (!acc) {
        check(`account.${label}`, false, `${id} not found on ${profile.name}`);
        continue;
      }
      if (label === "sponsor") sponsorAccounts.push(acc);
      const owned = label === "sponsor" && state
        ? state.pools.flatMap((p) => p.sponsorships)
          .filter((s) => s.sponsor === id)
          .reduce((n, s) => n + s.units, 0)
        : undefined;
      checks.push(...assessRoleAccount(label, id, acc, reserve, minimum, owned));
    } catch (e) {
      check(`account.${label}`, false, `${id}: ${(e as Error).message}`);
    }
  }
  if (role === "service")
    checks.push(
      assessSponsorFunding(
        sponsorAccounts,
        config.sponsors.length,
        state,
        reserve,
        config.reserveCeiling!,
      ),
    );
}
await main();
const ready = checks.every((c) => c.ok);
console.log(
  JSON.stringify(
    { ready, role, recordedAt: new Date().toISOString(), checks },
    null,
    2,
  ),
);
process.exit(ready ? 0 : 1);
