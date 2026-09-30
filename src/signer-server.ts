import { dirname } from "node:path";
import { createServer } from "node:http";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { type Config, networkOf } from "./config.ts";
import { units } from "./stellar.ts";
import { LocalSigning, canonicalSigning, signingRequest } from "./signing.ts";
export type SignerLimits = {
  count: number;
  fee: string;
  /** Part of `count` usable only by graduation/handover templates. */
  maintenanceReserve: number;
};
/**
 * Testnet defaults: 100 distinct signatures and 1 XLM worst-case fees per UTC
 * day, with 20 of the 100 kept back for maintenance.
 */
export const DEFAULT_SIGNER_LIMITS: SignerLimits = {
  count: 100,
  fee: "10000000",
  maintenanceReserve: 20,
};
/**
 * Ceilings come from the signer's own configuration file, never from the API
 * or database. Mainnet configuration validation makes them mandatory.
 */
export function signerLimitsOf(config: Config): SignerLimits {
  if (!config.signerLimits) {
    if (networkOf(config).name === "mainnet")
      throw new Error("Mainnet signer requires explicit signerLimits");
    return DEFAULT_SIGNER_LIMITS;
  }
  return {
    count: config.signerLimits.count,
    fee: units(config.signerLimits.fee).toString(),
    maintenanceReserve: config.signerLimits.maintenanceReserve ?? 0,
  };
}
type Row = {
  key: string;
  hash: string;
  expires: number;
  day: string;
  fee: string;
  network?: string;
  kind?: string;
};
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
/**
 * Rows are kept while they can still matter: any row of today or yesterday
 * (daily counts survive a restart across the UTC boundary) and any row whose
 * validity has not expired (channel-sequence conflict detection). Nothing
 * that could still be charged or replayed is ever dropped.
 */
export function pruneJournal(rows: Row[], at = Math.floor(Date.now() / 1000)) {
  const keep = yesterday();
  return rows.filter((r) => r.day >= keep || r.expires > at);
}
// Independent, persisted ceilings survive API/database compromise and signer restarts.
// Conservatively charge every distinct signed envelope, whether or not submitted.
export function signerServer(
  config: Config,
  journalPath: string,
  limits: SignerLimits = signerLimitsOf(config),
) {
  if (limits.maintenanceReserve >= limits.count)
    throw new Error("maintenanceReserve must be below count");
  const profile = networkOf(config);
  const signer = new LocalSigning(config);
  let rows: Row[];
  try {
    rows = JSON.parse(readFileSync(journalPath, "utf8"));
    if (!Array.isArray(rows)) throw new Error("Invalid journal");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    if (profile.name === "mainnet")
      throw new Error("Mainnet signer journal missing; restore it or provision an empty journal before the first signature");
    rows = [];
  }
  // A journal is bound to one network. Rows written by another network's
  // signer, or unbound legacy rows on mainnet, mean the wrong journal path.
  if (
    rows.some(
      (r) =>
        (r.network !== undefined && r.network !== profile.passphrase) ||
        (profile.name === "mainnet" && r.network === undefined),
    )
  )
    throw new Error("Signer journal belongs to another network");
  let queue = Promise.resolve();
  return createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/sign") {
      res.writeHead(404).end();
      return;
    }
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > 24000) req.destroy();
    });
    req.on("end", () => {
      queue = queue
        .then(async () => {
          try {
            // Refuse to recreate or silently roll back the durable mainnet
            // allowance while this process is still running.
            if (
              profile.name === "mainnet" &&
              readFileSync(journalPath, "utf8") !== JSON.stringify(rows)
            )
              throw new Error("Mainnet signer journal changed unexpectedly");
            const input = signingRequest.parse(JSON.parse(data));
            const tx = canonicalSigning(input, config);
            const day = today(),
              hash = Buffer.from(tx.hash()).toString("hex");
            const key = input.channel + ":" + input.sequence;
            const previous = rows.find(
              (r) => r.key === key && r.expires > Math.floor(Date.now() / 1000),
            );
            if (previous && previous.hash !== hash)
              throw new Error("Conflicting channel sequence");
            if (!previous) {
              const used = rows.filter((r) => r.day === day);
              const fee = BigInt((tx.operations.length + 1) * config.baseFee);
              // Onboarding may use only the unreserved part of the daily count;
              // the template kind was validated by canonicalSigning, not by the caller.
              const usable =
                input.kind === "onboard"
                  ? limits.count - limits.maintenanceReserve
                  : limits.count;
              if (
                used.length >= usable ||
                used.reduce((n, r) => n + BigInt(r.fee), 0n) + fee >
                  BigInt(limits.fee)
              )
                throw new Error("Signer daily ceiling");
              const next = [
                ...pruneJournal(rows),
                {
                  key,
                  hash,
                  expires: input.expires,
                  day,
                  fee: String(fee),
                  network: profile.passphrase,
                  kind: input.kind,
                },
              ];
              // Persist the reservation before producing any signature; fail closed on disk errors.
              writeFileSync(journalPath + ".tmp", JSON.stringify(next), {
                mode: 0o600,
                flush: true,
              });
              renameSync(journalPath + ".tmp", journalPath);
              const directory = openSync(dirname(journalPath), "r");
              try {
                fsyncSync(directory);
              } finally {
                closeSync(directory);
              }
              rows = next;
            }
            const outer = await signer.sign(input);
            res
              .writeHead(200, { "content-type": "application/json" })
              .end(JSON.stringify({ envelope: outer.toXdr() }));
          } catch {
            res
              .writeHead(403)
              .end('{"error":"Signing policy rejected request"}');
          }
        })
        .catch(() => {
          if (!res.writableEnded) res.writeHead(503).end();
        });
    });
  });
}
