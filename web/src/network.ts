/**
 * Browser-side network profile. The browser never chooses a network: it reads
 * the profile the server is bound to from `/api/onboarding/network`, validates
 * it against a fixed table of known profiles, and fails closed (no wallet
 * connection, no signing) when the metadata is missing, malformed or changes
 * while the page is open. This module has no DOM dependency at import time so
 * the pure helpers are unit-testable under Node.
 */
export type NetworkName = "testnet" | "mainnet";
export type NetworkInfo = {
  name: NetworkName;
  passphrase: string;
  horizon: string;
  issuer: string;
  explorer: string;
  friendbot: string | null;
};
/** Fixed validation table: the server must describe one of these exactly. */
const KNOWN: Record<NetworkName, Omit<NetworkInfo, "name">> = {
  testnet: {
    passphrase: "Test SDF Network ; September 2015",
    horizon: "https://horizon-testnet.stellar.org",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    explorer: "https://stellar.expert/explorer/testnet",
    friendbot: "https://friendbot.stellar.org",
  },
  mainnet: {
    passphrase: "Public Global Stellar Network ; September 2015",
    horizon: "https://horizon.stellar.org",
    issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    explorer: "https://stellar.expert/explorer/public",
    friendbot: null,
  },
};
export function parseNetworkInfo(data: unknown): NetworkInfo {
  if (typeof data !== "object" || data === null)
    throw new Error("Malformed network metadata");
  const d = data as Record<string, unknown>;
  const name = d.name;
  if (name !== "testnet" && name !== "mainnet")
    throw new Error("Unknown network");
  const expected = KNOWN[name];
  if (
    d.passphrase !== expected.passphrase ||
    d.horizon !== expected.horizon ||
    d.issuer !== expected.issuer ||
    d.explorer !== expected.explorer ||
    d.friendbot !== expected.friendbot
  )
    throw new Error("Network metadata does not match a known profile");
  return { name, ...expected };
}
export const networkLabel = (n: NetworkInfo | null) =>
  n === null
    ? "Network unavailable"
    : n.name === "mainnet"
      ? "Stellar mainnet"
      : "Stellar testnet";
export const networkBadge = (n: NetworkInfo | null) =>
  n === null
    ? "NETWORK UNAVAILABLE"
    : n.name === "mainnet"
      ? "STELLAR MAINNET"
      : "STELLAR TESTNET";
export const explorerLink = (
  n: NetworkInfo,
  kind: "tx" | "account",
  id: string,
) => `${n.explorer}/${kind}/${encodeURIComponent(id)}`;
/** Faucet link, or null on networks without a faucet (never shown on mainnet). */
export const friendbotLink = (n: NetworkInfo, account: string) =>
  n.friendbot ? `${n.friendbot}?addr=${encodeURIComponent(account)}` : null;
export const isMainnet = (n: NetworkInfo | null) => n?.name === "mainnet";
export const networkSpecificCopy = (
  n: NetworkInfo | null,
  mainnet: string,
  testnet: string,
) =>
  n === null
    ? "Network information unavailable. Reload the page and try again."
    : n.name === "mainnet"
      ? mainnet
      : testnet;
// ---- runtime store (browser) ----
let current: NetworkInfo | null = null;
const listeners = new Set<() => void>();
export const getNetworkInfo = () => current;
export function subscribeNetwork(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function set(value: NetworkInfo | null) {
  current = value;
  listeners.forEach((fn) => fn());
}
async function fetchNetworkInfo(): Promise<NetworkInfo> {
  const response = await fetch("/api/onboarding/network", {
    cache: "no-store",
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error("Network metadata unavailable");
  return parseNetworkInfo(await response.json());
}
/** Initial load. Any failure leaves the profile unset, which disables wallet actions. */
export async function loadNetworkInfo() {
  try {
    set(await fetchNetworkInfo());
  } catch {
    set(null);
  }
  return current;
}
/**
 * Re-read the profile immediately before signing. A server that was rebound
 * or a page left open across a deployment must never sign with stale data.
 */
export async function revalidateNetworkInfo(): Promise<NetworkInfo> {
  const fresh = await fetchNetworkInfo();
  if (
    current &&
    (current.name !== fresh.name || current.passphrase !== fresh.passphrase)
  ) {
    set(null);
    throw new Error("Network changed since this page loaded. Reload the page.");
  }
  set(fresh);
  return fresh;
}
