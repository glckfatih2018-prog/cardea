import type { NetworkSnapshot } from "./stellar.ts";
export type IntentState =
  | "AWAITING_SIGNATURE"
  | "READY"
  | "UNKNOWN"
  | "CONFIRMED"
  | "FAILED"
  | "EXPIRED"
  | "REJECTED";
export type Intent = {
  id: string;
  pool: string;
  recipient: string;
  kind: "onboard" | "graduate" | "handover";
  admission?: "public";
  trustlineOnly?: boolean;
  target?: string;
  sponsor: string;
  channel: string;
  sequence: string;
  expires: number;
  state: IntentState;
  unsigned: string;
  envelope?: string;
  hash?: string;
  innerHash?: string;
  tokenHash: string;
  cost: string;
  feeReserve: string;
  feeDay: string;
  feeActual?: string;
  ledger?: number;
  attempts: number;
  created: number;
  lastAttempt?: number;
  entries?: { account: boolean; trustline: boolean };
  reason?: string;
  /**
   * Hash of the envelope that actually reached the ledger when it differs from
   * `hash` (a third party re-wrapped the same signed inner transaction). `hash`
   * always remains the envelope Cardea signed and is the key for stale guards.
   */
  landedHash?: string;
  /** Salted digest of the trusted client identity that opened a public request. */
  clientHash?: string;
};
export type Sponsorship = {
  recipient: string;
  sponsor: string;
  units: number;
  status: "ACTIVE" | "GRADUATED" | "TRANSFERRED" | "CLOSED";
  ledger: number;
};
export type Pool = {
  id: string;
  name: string;
  description?: string;
  participantLimit?: number | null;
  sponsor: string;
  access?: "private" | "public";
  invite: string;
  status: "PAUSED" | "ACTIVE";
  reason: string;
  cap: string;
  feeCap: string;
  allowlist: string[];
  consumed: string[];
  fees: Record<string, string>;
  sponsorships: Sponsorship[];
  attempts: Record<string, number>;
  prepares?: Record<string, number>;
};
export type State = {
  version: 1;
  revision?: number;
  /**
   * Network passphrase this state belongs to. Written at first initialization
   * and checked on every startup and transaction. Legacy rows without it are
   * adopted as testnet only; a mainnet installation always starts empty.
   */
  network?: string;
  pools: Pool[];
  intents: Intent[];
  sessions: { hash: string; csrf: string; expires: number }[];
  snapshot?: NetworkSnapshot;
  workerAt: number;
  monitorAt?: number;
  haltReason?: string;
  /** Verified public admissions per UTC day across all pools. */
  publicSigned?: Record<string, number>;
  /** Recipients whose last coherent monitor reading could cover their own reserve. */
  eligible?: string[];
  /** Rotating position of the bounded automatic graduation pass. */
  graduationCursor?: number;
};
export const ARCHIVE_AFTER = 7 * 86400;
export const GRADUATION_COOLDOWN = 86400;
/** Terminal rows old enough to leave hot state. Pending rows never archive. */
export const archivable = (i: Intent, at: number) =>
  !pending(i) &&
  i.created < at - ARCHIVE_AFTER &&
  !(
    i.kind === "graduate" &&
    i.state === "FAILED" &&
    i.created > at - GRADUATION_COOLDOWN
  );
export const initial = (network?: string): State => ({
  version: 1,
  ...(network ? { network } : {}),
  pools: [],
  intents: [],
  sessions: [],
  workerAt: 0,
});
export const pending = (i: Intent) =>
  ["AWAITING_SIGNATURE", "READY", "UNKNOWN"].includes(i.state);
/** Signed envelopes that may still land; only these rows accept worker transitions. */
export const signed = (i: Intent) => ["READY", "UNKNOWN"].includes(i.state);
export type Entries = { account: boolean; trustline: boolean };
/**
 * Sponsorship records encode ownership as units: 0 none, 1 trustline, 2 account,
 * 3 both. Anything else is corrupt persisted state and fails closed.
 */
export function entriesOf(units: unknown): Entries {
  if (
    !Number.isInteger(units) ||
    (units as number) < 0 ||
    (units as number) > 3
  )
    throw new Error("Invalid sponsorship units");
  const u = units as number;
  return { account: (u & 2) !== 0, trustline: (u & 1) !== 0 };
}
export const unitsOf = (e: Entries) =>
  (e.account ? 2 : 0) + (e.trustline ? 1 : 0);
export const intersectEntries = (a: Entries, b: Entries): Entries => ({
  account: a.account && b.account,
  trustline: a.trustline && b.trustline,
});
/** True when every entry claimed by `owned` is present in `actual`. */
export const coversEntries = (actual: Entries, owned: Entries) =>
  (!owned.account || actual.account) && (!owned.trustline || actual.trustline);
/** Per-pool retry counter keys. Legacy `day:recipient` keys are never read. */
export const retryKey = (
  scope: "private" | "signed",
  d: string,
  recipient: string,
) => scope + ":" + d + ":" + recipient;
export const RECIPIENT_RETRY_LIMIT = 3;
export const now = () => Math.floor(Date.now() / 1000);
export const day = () => new Date().toISOString().slice(0, 10);

export function participation(s: State, p: Pool) {
  const joined = new Set(p.consumed);
  const reserved = new Set(
    s.intents
      .filter(
        (i) =>
          i.pool === p.id &&
          i.kind === "onboard" &&
          pending(i) &&
          !joined.has(i.recipient),
      )
      .map((i) => i.recipient),
  );
  return { participants: joined.size, pendingParticipants: reserved.size };
}

export type PoolListing = {
  id: string;
  name: string;
  description: string;
  access: "public" | "private";
  participants: number;
  pendingParticipants: number;
  participantLimit: number | null;
  availability: "open" | "full" | "reserved" | "paused" | "unavailable";
};
