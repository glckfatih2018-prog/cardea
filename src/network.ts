import { Asset, Networks } from "@stellar/stellar-sdk";
/**
 * Immutable network profiles. A configuration names exactly one passphrase;
 * that passphrase resolves to one complete profile (Horizon, canonical Circle
 * USDC issuer, explorer). Nothing else in the application chooses a network,
 * and no profile field can be overridden individually, so a mixed profile
 * (mainnet passphrase with a testnet issuer, or vice versa) cannot exist.
 *
 * Network and classic USDC asset constants checked against Stellar's official
 * network and asset documentation (2026-09-29):
 *   https://developers.stellar.org/docs/networks
 *   https://developers.stellar.org/docs/build/agentic-payments/x402
 */
export type NetworkName = "testnet" | "mainnet";
export type NetworkProfile = Readonly<{
  name: NetworkName;
  passphrase: string;
  horizon: string;
  issuer: string;
  explorer: string;
  /** Faucet for valueless test XLM; null where no faucet exists. */
  friendbot: string | null;
}>;
export const TESTNET: NetworkProfile = Object.freeze({
  name: "testnet",
  passphrase: "Test SDF Network ; September 2015",
  horizon: "https://horizon-testnet.stellar.org",
  issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  explorer: "https://stellar.expert/explorer/testnet",
  friendbot: "https://friendbot.stellar.org",
});
export const MAINNET: NetworkProfile = Object.freeze({
  name: "mainnet",
  passphrase: "Public Global Stellar Network ; September 2015",
  horizon: "https://horizon.stellar.org",
  issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  explorer: "https://stellar.expert/explorer/public",
  friendbot: null,
});
if (
  TESTNET.passphrase !== Networks.TESTNET ||
  MAINNET.passphrase !== Networks.PUBLIC
)
  throw new Error("Network passphrases disagree with the Stellar SDK");
const PROFILES: readonly NetworkProfile[] = Object.freeze([TESTNET, MAINNET]);
/** Exact passphrase match only. Unknown, empty or padded values are rejected. */
export function resolveNetwork(passphrase: unknown): NetworkProfile {
  const profile = PROFILES.find((p) => p.passphrase === passphrase);
  if (typeof passphrase !== "string" || !profile)
    throw new Error("Unknown network passphrase");
  return profile;
}
export const usdc = (profile: NetworkProfile) =>
  new Asset("USDC", profile.issuer);
/** Public, non-sensitive description served to browsers. */
export function publicProfile(profile: NetworkProfile) {
  return {
    name: profile.name,
    passphrase: profile.passphrase,
    horizon: profile.horizon,
    issuer: profile.issuer,
    explorer: profile.explorer,
    friendbot: profile.friendbot,
  };
}
