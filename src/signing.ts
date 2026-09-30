import { request } from "node:http";
import {
  Keypair,
  Transaction,
  TransactionBuilder,
  FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import { type Config, Signers, networkOf } from "./config.ts";
import {
  NETWORK,
  onboarding,
  maintenance,
  verifyRecipient,
  wrap,
} from "./stellar.ts";
import { z } from "zod";
export const signingRequest = z
  .object({
    kind: z.enum(["onboard", "graduate", "handover"]),
    /**
     * Passphrase the caller believes it is operating on. Optional for testnet
     * compatibility; a mainnet signer refuses requests that omit it or name
     * any other network.
     */
    network: z.string().optional(),
    sponsor: z.string(),
    recipient: z.string(),
    channel: z.string(),
    sequence: z.string().regex(/^[1-9]\d{0,19}$/),
    expires: z.number().int(),
    target: z.string().optional(),
    trustlineOnly: z.boolean().optional(),
    entries: z
      .object({ account: z.boolean(), trustline: z.boolean() })
      .strict()
      .optional(),
    xdr: z.string().max(20000),
  })
  .strict();
export type SigningRequest = z.infer<typeof signingRequest>;
export interface Signing {
  sign(input: SigningRequest): Promise<FeeBumpTransaction>;
}
// Rebuild from allowed operations. Never trust an API/database-provided expected XDR.
export function canonicalSigning(
  input: SigningRequest,
  config: Config,
): Transaction {
  const i = signingRequest.parse(input);
  const profile = networkOf(config);
  if (
    (i.network !== undefined && i.network !== profile.passphrase) ||
    (profile.name === "mainnet" && i.network !== profile.passphrase)
  )
    throw new Error("Signing network outside policy");
  if (
    !config.sponsors.includes(i.sponsor) ||
    !config.channels.includes(i.channel) ||
    [...config.sponsors, ...config.channels, config.feePayer].includes(
      i.recipient,
    )
  )
    throw new Error("Signing role outside policy");
  const now = Math.floor(Date.now() / 1000),
    boundary = (Math.floor(now / 86400) + 1) * 86400;
  if (
    i.expires <= now ||
    i.expires > Math.min(now + 180, boundary - 1) ||
    BigInt(i.sequence) < 1n
  )
    throw new Error("Signing validity outside policy");
  if (
    (i.kind === "handover") !== !!i.target ||
    (i.target &&
      (!config.sponsors.includes(i.target) || i.target === i.sponsor))
  )
    throw new Error("Signing target outside policy");
  const build = { ...i, sequence: (BigInt(i.sequence) - 1n).toString() };
  if (i.kind === "onboard") {
    if (i.entries) throw new Error("Unexpected entries");
    return verifyRecipient(
      onboarding(build, profile).toXdr(),
      i.xdr,
      i.recipient,
      profile.passphrase,
    );
  }
  if (i.trustlineOnly !== undefined)
    throw new Error("Unexpected onboarding mode");
  if (!i.entries || (!i.entries.account && !i.entries.trustline))
    throw new Error("Missing entries");
  const expected = maintenance(build, i.target, i.entries, profile);
  const actual = TransactionBuilder.fromXdr(i.xdr, profile.passphrase);
  if (
    !(actual instanceof Transaction) ||
    actual.signatures.length ||
    !Buffer.from(actual.signatureBase()).equals(
      Buffer.from(expected.signatureBase()),
    )
  )
    throw new Error("Modified maintenance transaction");
  return expected;
}
export class LocalSigning implements Signing {
  private keys: Signers;
  constructor(private config: Config) {
    this.keys = new Signers(config);
  }
  async sign(input: SigningRequest) {
    const tx = canonicalSigning(input, this.config);
    return wrap(
      tx,
      [
        input.channel,
        input.sponsor,
        ...(input.target ? [input.target] : []),
      ].map((k) => this.keys.get(k)),
      this.keys.get(this.config.feePayer),
      this.config.baseFee,
      networkOf(this.config).passphrase,
    );
  }
}
export class RemoteSigning implements Signing {
  /**
   * @param passphrase network the caller operates on; the returned envelope is
   *   decoded and verified under this passphrase only.
   * @param feePayer when given, the fee-bump must carry a valid fee-payer
   *   signature over the hash computed for `passphrase`. A signer running on
   *   another network produces a signature over a different hash and is
   *   rejected before anything is persisted.
   */
  constructor(
    private socket: string,
    private passphrase: string = NETWORK,
    private feePayer?: string,
    /** When given, the fee-bump total must be exactly baseFee x (operations + 1). */
    private baseFee?: number,
  ) {}
  async sign(input: SigningRequest): Promise<FeeBumpTransaction> {
    const body = JSON.stringify(input);
    const envelope = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socket,
          method: "POST",
          path: "/sign",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
            if (data.length > 32000)
              req.destroy(new Error("Signer response too large"));
          });
          res.on("end", () => {
            if (res.statusCode !== 200)
              return reject(new Error("Signer rejected request"));
            try {
              resolve(JSON.parse(data).envelope);
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.setTimeout(5000, () => req.destroy(new Error("Signer timeout")));
      req.on("error", reject);
      req.end(body);
    });
    const outer = TransactionBuilder.fromXdr(envelope, this.passphrase);
    if (!(outer instanceof FeeBumpTransaction))
      throw new Error("Invalid signer result");
    // The signer must have wrapped exactly the body we asked for: same
    // signature base as the request's inner transaction (and therefore the
    // same hash under this passphrase), bounded to the expected fee.
    const requested = TransactionBuilder.fromXdr(input.xdr, this.passphrase);
    const inner = outer.innerTransaction;
    if (
      !(requested instanceof Transaction) ||
      !Buffer.from(inner.signatureBase()).equals(
        Buffer.from(requested.signatureBase()),
      )
    )
      throw new Error("Signer returned a different transaction");
    if (
      this.baseFee !== undefined &&
      outer.fee !== String(this.baseFee * (inner.operations.length + 1))
    )
      throw new Error("Signer fee outside policy");
    if (this.feePayer) {
      const payer = Keypair.fromPublicKey(this.feePayer);
      if (
        outer.feeSource !== this.feePayer ||
        !outer.signatures.some((s) => payer.verify(outer.hash(), s.signature))
      )
        throw new Error("Signer result is not signed for this network");
    }
    return outer;
  }
}
