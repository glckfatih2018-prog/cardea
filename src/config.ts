import { readFileSync, statSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { z } from "zod";
import {
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { address, units } from "./stellar.ts";
import { resolveNetwork, type NetworkProfile } from "./network.ts";
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
export async function passwordMatches(password: string, encoded: string) {
  const [salt, h] = encoded.split(":");
  if (!salt || !h || password.length > 256) return false;
  const a = await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, (error, key) =>
        error ? reject(error) : resolve(key),
      );
    }),
    b = Buffer.from(h, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
/**
 * Exact sentence an operator must place in `mainnet.acknowledge`. It is not a
 * secret; it exists so that a mainnet installation can never be the result of
 * a copied testnet file with one field changed.
 */
export const MAINNET_ACKNOWLEDGEMENT =
  "I understand this installation signs real XLM sponsorships on the Stellar public network";
/** Decimal XLM string, exact stroop precision, no exponent or sign. */
const amount = z.string().regex(/^\d{1,12}(\.\d{1,7})?$/);
const schema = z
  .object({
    network: z.string().min(1),
    databaseUrl: z.string(),
    namespace: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,60}$/)
      .default("cardea"),
    origin: z.string().url(),
    port: z.number().int().min(1024).max(65535).default(4317),
    operatorHash: z.string().regex(/^[a-f0-9]{32}:[a-f0-9]{128}$/),
    keys: z.array(z.string()).default([]),
    signerSocket: z.string().startsWith("/").optional(),
    relaySecret: z.string().min(32).optional(),
    sponsors: z.array(z.string()).min(1),
    channels: z.array(z.string()).min(1),
    feePayer: z.string(),
    baseFee: z.number().int().min(100).max(10000).default(1000),
    maxDailyAttempts: z.number().int().min(1).max(1000).default(100),
    autoGraduate: z.boolean().default(true),
    /**
     * Installation-wide ceiling on committed plus pending sponsored reserve
     * (decimal XLM) across every pool. Optional on testnet, mandatory on mainnet.
     */
    reserveCeiling: amount.optional(),
    /**
     * Independent daily ceilings enforced by the signer process from its own
     * configuration: distinct signed envelopes and worst-case fees (decimal XLM).
     * Optional on testnet (defaults apply), mandatory on mainnet.
     */
    signerLimits: z
      .object({
        count: z.number().int().min(1).max(100000),
        fee: amount,
        /**
         * Signatures of the daily count kept back for graduation/handover so
         * public onboarding cannot starve maintenance. Enforced by the signer
         * from the validated template kind. Mainnet: mandatory, >= 1, < count.
         */
        maintenanceReserve: z.number().int().min(0).max(100000).optional(),
      })
      .strict()
      .optional(),
    /**
     * Verified public (invitation-free) admissions per UTC day across all
     * pools, enforced by the API after the recipient's signature. Testnet
     * default: maxDailyAttempts. Mainnet: mandatory explicit value; zero
     * disables public onboarding during a private pilot.
     */
    publicDailyAdmissions: z.number().int().min(0).max(100000).optional(),
    /** Explicit mainnet opt-in. Absent on testnet. */
    mainnet: z
      .object({ acknowledge: z.literal(MAINNET_ACKNOWLEDGEMENT) })
      .strict()
      .optional(),
  })
  .strict();
export type Config = z.infer<typeof schema>;
/**
 * `service`: the API and worker. `signer`: the constrained signer process.
 * The roles have opposite key requirements on mainnet, so a file written for
 * one cannot be started as the other by mistake.
 */
export type ConfigRole = "service" | "signer";
export const networkOf = (c: Pick<Config, "network">): NetworkProfile =>
  resolveNetwork(c.network);
export function validateConfig(
  data: unknown,
  role: ConfigRole = "service",
): Config {
  const c = schema.parse(data);
  const profile = resolveNetwork(c.network);
  const origin = new URL(c.origin);
  if (
    origin.origin !== c.origin ||
    !(
      origin.protocol === "https:" ||
      (origin.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(origin.hostname))
    )
  )
    throw new Error("HTTPS origin required outside loopback");
  const keys = new Set(c.keys.map((s) => Keypair.fromSecret(s).publicKey()));
  const roles = [...c.sponsors, ...c.channels, c.feePayer];
  roles.forEach(address);
  if (
    new Set(roles).size !== roles.length ||
    (!c.signerSocket && roles.some((a) => !keys.has(a)))
  )
    throw new Error("Roles must be distinct and have configured signers");
  if (c.signerSocket && c.keys.length)
    throw new Error("Remote signer mode must not contain keys");
  if (role === "signer" && (!c.keys.length || c.signerSocket))
    throw new Error("Signer requires private local keys");
  if (c.reserveCeiling !== undefined && units(c.reserveCeiling) <= 0n)
    throw new Error("reserveCeiling must be positive");
  if (c.signerLimits && units(c.signerLimits.fee) <= 0n)
    throw new Error("signerLimits.fee must be positive");
  if (
    c.signerLimits &&
    c.signerLimits.maintenanceReserve !== undefined &&
    c.signerLimits.maintenanceReserve >= c.signerLimits.count
  )
    throw new Error("signerLimits.maintenanceReserve must be below count");
  if (profile.name === "mainnet") {
    // Every mainnet requirement is explicit and positive. Nothing is guessed.
    if (!c.mainnet)
      throw new Error(
        "Mainnet requires mainnet.acknowledge with the exact acknowledgement sentence",
      );
    if (c.reserveCeiling === undefined)
      throw new Error("Mainnet requires an explicit positive reserveCeiling");
    if (!c.signerLimits)
      throw new Error(
        "Mainnet requires explicit positive signerLimits.count and signerLimits.fee",
      );
    if (
      c.signerLimits.maintenanceReserve === undefined ||
      c.signerLimits.maintenanceReserve < 1
    )
      throw new Error(
        "Mainnet requires explicit positive signerLimits.maintenanceReserve",
      );
    if (c.publicDailyAdmissions === undefined)
      throw new Error("Mainnet requires explicit publicDailyAdmissions");
    const explicitNamespace =
      typeof data === "object" &&
      data !== null &&
      typeof (data as { namespace?: unknown }).namespace === "string";
    if (!explicitNamespace || c.namespace === "cardea")
      throw new Error(
        "Mainnet requires a dedicated explicit namespace (not the default)",
      );
    if (origin.protocol !== "https:")
      throw new Error("Mainnet requires an HTTPS origin");
    if (role === "service") {
      if (!c.signerSocket || c.keys.length)
        throw new Error(
          "Mainnet API/worker must use the remote signer and hold no keys",
        );
      if (!c.relaySecret) throw new Error("Mainnet API requires relaySecret");
    }
  } else if (c.mainnet)
    throw new Error("mainnet acknowledgement present on a non-mainnet profile");
  return c;
}
export function loadConfig(role: ConfigRole = "service") {
  const path = process.env.CARDEA_CONFIG;
  if (!path)
    throw new Error("Set CARDEA_CONFIG to a private configuration file");
  if ((statSync(path).mode & 0o077) !== 0)
    throw new Error("Config permissions must be 0600");
  return validateConfig(JSON.parse(readFileSync(path, "utf8")), role);
}
export class Signers {
  private keys: Map<string, Keypair>;
  constructor(c: Config) {
    this.keys = new Map(
      c.keys.map((k) => {
        const p = Keypair.fromSecret(k);
        return [p.publicKey(), p];
      }),
    );
  }
  get(publicKey: string) {
    const key = this.keys.get(publicKey);
    if (!key) throw new Error("Signer not configured");
    return key;
  }
}
