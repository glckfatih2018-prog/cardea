import { type Signing, LocalSigning, RemoteSigning } from "./signing.ts";
import { randomUUID, createHmac } from "node:crypto";
import {
  FeeBumpTransaction,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { Store } from "./db.ts";
import { type Config, digest, token, networkOf } from "./config.ts";
import { type NetworkProfile, publicProfile } from "./network.ts";
import {
  type State,
  type Pool,
  type Intent,
  type PoolListing,
  type Sponsorship,
  type Entries,
  participation,
  pending,
  signed,
  entriesOf,
  unitsOf,
  intersectEntries,
  coversEntries,
  retryKey,
  archivable,
  RECIPIENT_RETRY_LIMIT,
  GRADUATION_COOLDOWN,
  ARCHIVE_AFTER,
  now,
  day,
} from "./model.ts";
import {
  type Chain,
  type ChainAccount,
  type ChainResult,
  type NetworkSnapshot,
  onboarding,
  maintenance,
  verifyRecipient,
  available,
  sponsored,
  hex,
  units,
  address,
} from "./stellar.ts";
export class Problem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function ensure(
  condition: unknown,
  message: string,
  status = 409,
): asserts condition {
  if (!condition) throw new Problem(status, message);
}
/** Bounded-concurrency map preserving order; used for Horizon fan-out. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const n = next++;
        out[n] = await fn(items[n]);
      }
    },
  );
  await Promise.all(workers);
  return out;
}
/** Automatic graduation attempts per worker cycle and Horizon fan-out width. */
export const GRADUATIONS_PER_TICK = 5;
export const HORIZON_FANOUT = 8;
const ALL_ENTRIES: Entries = { account: true, trustline: true };
export class Cardea {
  readonly signing: Signing;
  /** Resolved once from the configured passphrase; used end to end. */
  readonly networkProfile: NetworkProfile;
  /** Public preparations currently performing Horizon observations. */
  private publicObservations = 0;
  constructor(
    readonly store: Store,
    readonly chain: Chain,
    readonly config: Config,
  ) {
    this.networkProfile = networkOf(config);
    if (store.network !== this.networkProfile.passphrase)
      throw new Error(
        "Store is bound to a different network than the configuration",
      );
    if (this.networkProfile.name === "mainnet" && !config.signerSocket)
      throw new Error("Mainnet requires the remote signer; no in-process keys");
    this.signing = config.signerSocket
      ? new RemoteSigning(
          config.signerSocket,
          this.networkProfile.passphrase,
          config.feePayer,
          config.baseFee,
        )
      : new LocalSigning(config);
  }
  /** Public, non-sensitive network metadata for browsers and integrators. */
  network() {
    return publicProfile(this.networkProfile);
  }
  /**
   * Committed plus pending sponsored reserve across every pool, in stroops.
   * A pending handover moves an existing reserve to another configured
   * sponsor atomically; it is not new reserve and is not counted twice.
   */
  private globalReserve(s: State, reserve: bigint) {
    const active = s.pools
      .flatMap((p) => p.sponsorships)
      .reduce((n, r) => n + BigInt(r.units) * reserve, 0n);
    const reserved = s.intents
      .filter((i) => pending(i) && i.kind === "onboard")
      .reduce((n, i) => n + BigInt(i.cost), 0n);
    return active + reserved;
  }
  /** Installation-wide ceiling independent of editable pool limits (new reserve only). */
  private ceiling(s: State, snap: NetworkSnapshot, cost: bigint) {
    if (this.config.reserveCeiling === undefined) return;
    ensure(
      this.globalReserve(s, BigInt(snap.reserve)) + cost <=
        units(this.config.reserveCeiling),
      "Installation reserve ceiling reached",
    );
  }
  invitation(p: Pool, recipient: string) {
    return createHmac("sha256", p.invite)
      .update("cardea-onboard:" + recipient)
      .digest("base64url");
  }
  private clientHash(client: string) {
    return digest("cardea-client:" + client);
  }
  private expiry() {
    const t = now(),
      boundary = (Math.floor(t / 86400) + 1) * 86400;
    ensure(boundary - t > 15, "UTC fee budget rollover; retry shortly", 429);
    return Math.min(t + 180, boundary - 1);
  }
  /** A channel read must cover the observed ledger and known landed sequences. */
  private async channelAccount(
    channel: string,
    snap: NetworkSnapshot,
    s: State,
  ) {
    const read = await this.chain.accountWithLedger(channel);
    ensure(
      read.account &&
        read.ledger !== null &&
        read.ledger >= Math.max(snap.ledger, s.snapshot?.ledger ?? 0),
      "Ledger confirmation unavailable for channel; retry",
      503,
    );
    ensure(
      s.intents.every(
        (i) =>
          i.channel !== channel ||
          (i.state !== "CONFIRMED" && i.state !== "FAILED") ||
          BigInt(read.account!.sequence) >= BigInt(i.sequence),
      ),
      "Channel sequence confirmation unavailable; retry",
      503,
    );
    return read.account;
  }
  private healthy(s: State) {
    ensure(!s.haltReason, s.haltReason ?? "Halted");
    ensure(now() - s.workerAt < 90, "Worker unavailable");
    ensure(now() - (s.monitorAt ?? 0) < 90, "Reserve monitor unavailable");
  }
  pool(s: State, id: string) {
    const p = s.pools.find((p) => p.id === id);
    if (!p) throw new Problem(404, "Pool not found");
    return p;
  }
  /** Mainnet funding isolation: a signer account may back only one pool. */
  private sponsorAssigned(s: State, sponsor: string, exceptPool?: string) {
    return (
      s.pools.some(
        (p) =>
          p.id !== exceptPool &&
          (p.sponsor === sponsor ||
            p.sponsorships.some((r) => r.sponsor === sponsor)),
      ) ||
      s.intents.some(
        (i) =>
          i.pool !== exceptPool &&
          (i.sponsor === sponsor || i.target === sponsor),
      )
    );
  }
  async createPool(
    name: string,
    sponsor: string,
    cap: string,
    feeCap: string,
    description = "",
    participantLimit: number | null = 50,
  ) {
    this.validateProfile(name, description, participantLimit);
    ensure(this.config.sponsors.includes(sponsor), "Unknown sponsor", 400);
    const c = units(cap),
      f = units(feeCap);
    ensure(c > 0n && f > 0n, "Positive limits required", 400);
    return this.store.change((s, audit) => {
      ensure(s.pools.length < 100, "Pool limit reached");
      if (this.networkProfile.name === "mainnet")
        ensure(
          !this.sponsorAssigned(s, sponsor),
          "This sponsor account already belongs to a pool. Configure a separate funded sponsor account for each mainnet pool.",
          409,
        );
      const p: Pool = {
        id: randomUUID(),
        name,
        description: description.trim(),
        participantLimit,
        sponsor,
        cap: c.toString(),
        feeCap: f.toString(),
        status: "PAUSED",
        reason: "Activate after funding verification",
        invite: token(),
        allowlist: [],
        consumed: [],
        fees: {},
        attempts: {},
        sponsorships: [],
      };
      s.pools.push(p);
      audit({ action: "pool.created", pool: p.id });
      return p;
    });
  }
  async allowlist(id: string, addresses: string[], remove = false) {
    addresses.forEach(address);
    return this.store.change((s, audit) => {
      const p = this.pool(s, id);
      p.allowlist = remove
        ? p.allowlist.filter((a) => !addresses.includes(a))
        : [...new Set([...p.allowlist, ...addresses])];
      ensure(p.allowlist.length <= 5000, "Allowlist limit 5000", 400);
      audit({
        action: remove ? "allowlist.revoked" : "allowlist.imported",
        pool: id,
        count: addresses.length,
      });
      return { count: p.allowlist.length };
    });
  }
  async policy(id: string, active: boolean) {
    const snap = await this.chain.snapshot();
    const before = await this.store.read();
    const p0 = this.pool(before, id);
    const acc = await this.chain.account(p0.sponsor);
    const payer = await this.chain.account(this.config.feePayer);
    return this.store.change((s, audit) => {
      const p = this.pool(s, id);
      if (active) {
        this.healthy(s);
        ensure(acc && payer, "Fund sponsor and fee payer first");
        ensure(
          available(acc!, BigInt(snap.reserve)) >= 3n * BigInt(snap.reserve),
          "Sponsor capacity insufficient",
        );
        ensure(
          available(payer!, BigInt(snap.reserve)) >=
            BigInt(this.config.baseFee * 5),
          "Fee payer insufficient",
        );
        ensure(
          !s.intents.some((i) => pending(i) && i.sponsor === p.sponsor),
          "Wait for pending intents before activation",
        );
        const expected = s.pools
          .flatMap((p) => p.sponsorships)
          .filter((x) => x.sponsor === p.sponsor)
          .reduce((n, x) => n + x.units, 0);
        ensure(
          acc!.num_sponsoring === expected,
          "Unexplained sponsoring count",
        );
      }
      p.status = active ? "ACTIVE" : "PAUSED";
      p.reason = active ? "" : "Operator paused";
      audit({ action: active ? "pool.activated" : "pool.paused", pool: id });
      return p;
    });
  }
  async limits(id: string, cap: string, feeCap: string) {
    const c = units(cap),
      f = units(feeCap);
    ensure(c > 0n && f > 0n, "Positive limits required", 400);
    return this.store.change((s, audit) => {
      const p = this.pool(s, id),
        reserve = BigInt(s.snapshot?.reserve ?? "5000000");
      const committed =
        p.sponsorships.reduce((n, r) => n + BigInt(r.units) * reserve, 0n) +
        s.intents
          .filter((i) => i.pool === id && i.kind === "onboard" && pending(i))
          .reduce((n, i) => n + BigInt(i.cost), 0n);
      const fees =
        BigInt(p.fees[day()] ?? "0") +
        s.intents
          .filter((i) => i.pool === id && pending(i))
          .reduce((n, i) => n + BigInt(i.feeReserve), 0n);
      ensure(c >= committed, "Limit below committed reserve");
      ensure(f >= fees, "Limit below paid and pending fees");
      p.cap = c.toString();
      p.feeCap = f.toString();
      audit({
        action: "pool.limits_updated",
        pool: id,
        cap: p.cap,
        feeCap: p.feeCap,
      });
      return p;
    });
  }
  async rotateInvite(id: string) {
    return this.store.change((s, audit) => {
      const p = this.pool(s, id);
      p.invite = token();
      audit({ action: "pool.invite_rotated", pool: id });
      return { invite: p.invite };
    });
  }
  private capacity(
    s: State,
    p: Pool,
    snap: NetworkSnapshot,
    acc: ChainAccount,
    payer: ChainAccount,
    cost: bigint,
    fee: bigint,
  ) {
    const active = p.sponsorships.reduce(
      (n, x) => n + BigInt(x.units) * BigInt(snap.reserve),
      0n,
    );
    const reserved = s.intents
      .filter((i) => i.pool === p.id && i.kind === "onboard" && pending(i))
      .reduce((n, i) => n + BigInt(i.cost), 0n);
    ensure(
      active + reserved + cost <= BigInt(p.cap),
      "Pool reserve cap reached",
    );
    this.ceiling(s, snap, cost);
    const physical = s.intents
      .filter((i) => pending(i) && (i.target ?? i.sponsor) === acc.account_id)
      .reduce((n, i) => n + BigInt(i.cost), 0n);
    ensure(
      available(acc, BigInt(snap.reserve)) >= physical + cost,
      "Sponsor reserve insufficient",
    );
    const fees = s.intents
      .filter((i) => i.pool === p.id && pending(i))
      .reduce((n, i) => n + BigInt(i.feeReserve), 0n);
    ensure(
      BigInt(p.fees[day()] ?? "0") + fees + fee <= BigInt(p.feeCap),
      "Daily fee budget reached",
    );
    const allFees = s.intents
      .filter(pending)
      .reduce((n, i) => n + BigInt(i.feeReserve), 0n);
    ensure(
      available(payer, BigInt(snap.reserve)) >= allFees + fee,
      "Fee payer capacity insufficient",
    );
  }
  async setAccess(id: string, access: "private" | "public") {
    return this.store.change((s, audit) => {
      const p = this.pool(s, id);
      p.access = access;
      audit({ action: "pool.access", pool: id, access });
      return { access };
    });
  }
  async publicPools() {
    if (this.config.publicDailyAdmissions === 0) return [];
    const s = await this.store.read();
    if (
      s.haltReason ||
      now() - s.workerAt >= 90 ||
      now() - (s.monitorAt ?? 0) >= 90
    )
      return [];
    return s.pools
      .filter((p) => p.access === "public" && p.status === "ACTIVE")
      .map((p) => ({ id: p.id, name: p.name }));
  }
  private validateProfile(
    name: string,
    description: string,
    limit: number | null,
  ) {
    ensure(
      name.trim().length > 0 && name.length <= 80 && description.length <= 1000,
      "Invalid pool profile",
      400,
    );
    ensure(
      limit === null ||
        (Number.isSafeInteger(limit) && limit >= 1 && limit <= 100000),
      "Invalid participant limit",
      400,
    );
  }
  async profile(
    id: string,
    name: string,
    description: string,
    participantLimit: number | null,
  ) {
    this.validateProfile(name, description, participantLimit);
    return this.store.change((s, audit) => {
      const p = this.pool(s, id);
      const counts = participation(s, p);
      ensure(
        participantLimit === null ||
          participantLimit >= counts.participants + counts.pendingParticipants,
        "Limit below joined and pending participants",
      );
      p.name = name.trim();
      p.description = description.trim();
      p.participantLimit = participantLimit;
      audit({ action: "pool.profile_updated", pool: id, participantLimit });
      return { ok: true };
    });
  }
  private listing(s: State, p: Pool): PoolListing {
    const counts = participation(s, p);
    const limit = p.participantLimit ?? null;
    const availability =
      p.status !== "ACTIVE"
        ? "paused"
        : limit !== null && counts.participants >= limit
          ? "full"
          : limit !== null &&
              counts.participants + counts.pendingParticipants >= limit
            ? "reserved"
            : (p.access === "public" &&
                  this.config.publicDailyAdmissions === 0) ||
                s.haltReason ||
                now() - s.workerAt >= 90 ||
                now() - (s.monitorAt ?? 0) >= 90
              ? "unavailable"
              : "open";
    return {
      id: p.id,
      name: p.name,
      description: p.description ?? "",
      access: p.access ?? "private",
      ...counts,
      participantLimit: limit,
      availability,
    };
  }
  async directory(id?: string) {
    const s = await this.store.read();
    return id
      ? this.listing(s, this.pool(s, id))
      : s.pools.map((p) => this.listing(s, p));
  }
  /**
   * Unsigned public holds naming `recipient`. A valid private invitation for
   * the same wallet, or operator maintenance of that wallet, may supersede
   * them: they carry no signature and no institution commitment. Signed rows
   * are never superseded.
   */
  private publicHolds(s: State, recipient: string) {
    return s.intents.filter(
      (i) =>
        i.recipient === recipient &&
        i.admission === "public" &&
        i.state === "AWAITING_SIGNATURE",
    );
  }
  private supersede(
    s: State,
    recipient: string,
    reason: string,
    audit: (event: Record<string, unknown>) => void,
  ) {
    for (const h of this.publicHolds(s, recipient)) {
      h.state = "REJECTED";
      h.reason = reason;
      audit({ action: "intent.superseded", intent: h.id, recipient, reason });
    }
  }
  /** Private invitations may reuse a channel held only by their own unsigned public request. */
  private availableChannel(s: State, recipient: string, publicPoolId?: string) {
    return this.config.channels.find(
      (channel) =>
        !s.intents.some(
          (i) =>
            i.channel === channel &&
            pending(i) &&
            (publicPoolId !== undefined ||
              i.recipient !== recipient ||
              i.admission !== "public" ||
              i.state !== "AWAITING_SIGNATURE"),
        ),
    );
  }
  /**
   * Every guard that needs no Horizon observation. Evaluated before any
   * network call and again inside the state transaction. A public request
   * never spends any per-recipient counter; the per-client hold cap and the
   * half-channel share bound what one client can occupy.
   */
  private localGuards(
    s: State,
    p: Pool,
    recipient: string,
    publicPoolId: string | undefined,
    clientHash: string | undefined,
  ) {
    this.healthy(s);
    ensure(p.status === "ACTIVE", "Pool paused");
    ensure(
      publicPoolId || p.allowlist.includes(recipient),
      "Address is not on allowlist",
      403,
    );
    ensure(!p.consumed.includes(recipient), "Address already onboarded");
    const effective = publicPoolId
      ? s
      : {
          ...s,
          intents: s.intents.filter(
            (i) =>
              i.recipient !== recipient ||
              i.admission !== "public" ||
              i.state !== "AWAITING_SIGNATURE",
          ),
        };
    const counts = participation(effective, p);
    ensure(
      p.participantLimit == null ||
        counts.participants + counts.pendingParticipants < p.participantLimit,
      "Pool participant limit reached",
    );
    // A private invitation outranks unsigned public holds for the same wallet;
    // anything signed, and any hold against a public request, still blocks.
    ensure(
      !s.intents.some(
        (i) =>
          i.recipient === recipient &&
          pending(i) &&
          !(
            !publicPoolId &&
            i.admission === "public" &&
            i.state === "AWAITING_SIGNATURE"
          ),
      ),
      "An onboarding is already pending",
    );
    const d = day();
    // Signed attempts are consumed only by this recipient's own verified
    // signature (see submit), so refusing early cannot be forced by a third party.
    ensure(
      (p.prepares?.[retryKey("signed", d, recipient)] ?? 0) <
        RECIPIENT_RETRY_LIMIT,
      "Recipient retry limit reached",
      429,
    );
    // Unsigned abandonment is capped only for invitation holders: a public
    // request names any address and must never spend that address's quota.
    if (!publicPoolId)
      ensure(
        (p.prepares?.[retryKey("private", d, recipient)] ?? 0) <
          RECIPIENT_RETRY_LIMIT,
        "Recipient retry limit reached",
        429,
      );
    if (publicPoolId) {
      ensure(
        this.config.publicDailyAdmissions !== 0,
        "Public onboarding is disabled",
        403,
      );
      ensure(
        s.intents.filter((i) => i.admission === "public" && pending(i)).length <
          this.publicShare(),
        "Public pools are busy; retry shortly",
        429,
      );
      ensure(
        !s.intents.some(
          (i) =>
            i.admission === "public" &&
            i.state === "AWAITING_SIGNATURE" &&
            i.clientHash === clientHash,
        ),
        "One public request at a time per client; sign or wait for expiry",
        429,
      );
    }
    ensure(
      this.availableChannel(s, recipient, publicPoolId) !== undefined,
      "All channels busy; retry later",
      429,
    );
  }
  /** Channels that unsigned/pending public requests may occupy at once. */
  private publicShare() {
    return Math.max(1, Math.floor(this.config.channels.length / 2));
  }
  private findPool(
    s: State,
    invite: string,
    recipient: string,
    publicPoolId?: string,
  ) {
    return s.pools.find((p) =>
      publicPoolId
        ? p.id === publicPoolId && p.access === "public"
        : this.invitation(p, recipient) === invite,
    );
  }
  /**
   * @param client trusted client identity for public requests (relay-attested
   *   IP or socket IP). It is never taken from the request body. Required
   *   whenever `publicPoolId` is given; tests may pass synthetic values.
   */
  async prepare(
    invite: string,
    recipient: string,
    publicPoolId?: string,
    client?: string,
  ) {
    address(recipient);
    ensure(
      ![
        ...this.config.sponsors,
        ...this.config.channels,
        this.config.feePayer,
      ].includes(recipient),
      "Institution accounts cannot receive sponsorship",
      403,
    );
    if (publicPoolId) ensure(client, "Client identity required", 400);
    const clientHash = publicPoolId ? this.clientHash(client!) : undefined;
    if (publicPoolId) {
      // Bound the Horizon work public requests can trigger concurrently to the
      // same share they may hold; everything above is refused without I/O.
      ensure(
        this.publicObservations < this.publicShare(),
        "Public pools are busy; retry shortly",
        429,
      );
      this.publicObservations++;
    }
    try {
      return await this.store.observedChange(
        async (state) => {
          const p = this.findPool(state, invite, recipient, publicPoolId);
          ensure(
            p &&
              p.status === "ACTIVE" &&
              (publicPoolId || p.allowlist.includes(recipient)),
            "Invitation unavailable",
            404,
          );
          // All local refusals happen here, before the first Horizon call.
          this.localGuards(state, p, recipient, publicPoolId, clientHash);
          const selected = this.availableChannel(
            state,
            recipient,
            publicPoolId,
          )!;
          let snap = await this.chain.snapshot();
          let [user, acc, payer, ch] = await Promise.all([
            this.chain.account(recipient),
            this.chain.account(p.sponsor),
            this.chain.account(this.config.feePayer),
            this.channelAccount(selected, snap, state),
          ]);
          const claims = state.pools.flatMap((pool) =>
            pool.sponsorships.filter(
              (r) => r.recipient === recipient && r.units > 0,
            ),
          );
          if (
            claims.some(
              (r) =>
                unitsOf(
                  intersectEntries(
                    entriesOf(r.units),
                    user
                      ? sponsored(user, r.sponsor, this.networkProfile.issuer)
                      : { account: false, trustline: false },
                  ),
                ) < r.units,
            )
          ) {
            // A missing recipient entry may be a stale Horizon response. Only
            // release confirmed reserve from a coherent ledger and sponsor count.
            const start = await this.chain.snapshot();
            ensure(
              claims.every((r) => start.ledger >= r.ledger),
              "Ledger confirmation unavailable; retry",
            );
            const sponsors = [
              ...new Set([...claims.map((r) => r.sponsor), p.sponsor]),
            ];
            const [recipientRead, sponsorReads] = await Promise.all([
              this.chain.accountWithLedger(recipient),
              Promise.all(
                sponsors.map(
                  async (id) =>
                    [id, await this.chain.accountWithLedger(id)] as const,
                ),
              ),
            ]);
            const end = await this.chain.snapshot();
            ensure(
              start.ledger === end.ledger &&
                recipientRead.ledger === start.ledger &&
                sponsorReads.every(
                  ([, reading]) => reading.ledger === start.ledger,
                ),
              "Ledger confirmation unavailable; retry",
            );
            user = recipientRead.account;
            snap = start;
            const accounts = new Map(sponsorReads);
            acc = accounts.get(p.sponsor)!.account;
            for (const sponsor of sponsors) {
              const owned = claims.filter((r) => r.sponsor === sponsor);
              const decrease = owned.reduce(
                (n, r) =>
                  n +
                  r.units -
                  unitsOf(
                    intersectEntries(
                      entriesOf(r.units),
                      user
                        ? sponsored(user, r.sponsor, this.networkProfile.issuer)
                        : { account: false, trustline: false },
                    ),
                  ),
                0,
              );
              if (decrease === 0) continue;
              ensure(
                !state.intents.some(
                  (i) =>
                    signed(i) &&
                    (i.sponsor === sponsor || i.target === sponsor),
                ),
                "Sponsorship change pending; retry",
              );
              const settled = state.pools
                .flatMap((pool) => pool.sponsorships)
                .filter((r) => r.sponsor === sponsor)
                .reduce((n, r) => n + r.units, 0);
              ensure(
                accounts.get(sponsor)?.account?.num_sponsoring ===
                  settled - decrease,
                "Sponsor reserve confirmation unavailable; retry",
              );
            }
          }
          if (user) {
            ensure(
              !user.balances.some(
                (b) =>
                  b.asset_code === "USDC" &&
                  b.asset_issuer === this.networkProfile.issuer,
              ),
              "Your USDC trustline already exists",
            );
            ensure(
              (user.signers.find((k) => k.key === recipient)?.weight ?? 0) >=
                Math.max(1, user.thresholds?.med_threshold ?? 1),
              "This account requires additional signatures",
            );
          }
          return { snap, acc, payer, ch, user, trustlineOnly: !!user };
        },
        async (s, { snap, acc, payer, ch, user, trustlineOnly }, audit) => {
          const p = this.findPool(s, invite, recipient, publicPoolId);
          ensure(p, "Invitation unavailable", 404);
          this.localGuards(s, p!, recipient, publicPoolId, clientHash);
          if (!publicPoolId)
            this.supersede(
              s,
              recipient,
              "Superseded by the wallet's private invitation",
              audit,
            );
          const channel = this.config.channels.find(
            (c) => !s.intents.some((i) => i.channel === c && pending(i)),
          );
          ensure(channel, "All channels busy; retry later", 429);
          ensure(acc && payer && ch, "Funding unavailable");
          const cost = (trustlineOnly ? 1n : 3n) * BigInt(snap.reserve),
            fee = BigInt(this.config.baseFee * (trustlineOnly ? 4 : 5));
          ensure(
            snap.baseFee <= this.config.baseFee,
            "Network fee exceeds configured policy",
          );
          // The recipient was observed without a USDC trustline (and possibly
          // without an account). Any older record still claiming such an entry is
          // stale; release it before reserving so the new entry is not double-booked.
          this.reconcileRecipient(s, recipient, user, audit);
          this.capacity(s, p!, snap, acc!, payer!, cost, fee);
          const id = randomUUID(),
            secret = token(),
            expires = this.expiry(),
            d = day();
          const tx = onboarding(
            {
              trustlineOnly,
              channel: channel!,
              sequence: ch!.sequence,
              sponsor: p!.sponsor,
              recipient,
              expires,
            },
            this.networkProfile,
          );
          const i: Intent = {
            id,
            pool: p!.id,
            recipient,
            sponsor: p!.sponsor,
            kind: "onboard",
            trustlineOnly,
            ...(publicPoolId
              ? { admission: "public" as const, clientHash }
              : {}),
            channel: channel!,
            sequence: tx.sequence,
            expires,
            state: "AWAITING_SIGNATURE",
            unsigned: tx.toXdr(),
            innerHash: hex(tx.hash()),
            tokenHash: digest(secret),
            cost: cost.toString(),
            feeReserve: fee.toString(),
            feeDay: d,
            attempts: 0,
            created: now(),
          };
          s.intents.push(i);
          if (!publicPoolId) {
            p!.prepares ??= {};
            const privateAttempt = retryKey("private", d, recipient);
            p!.prepares[privateAttempt] =
              (p!.prepares[privateAttempt] ?? 0) + 1;
          }
          s.snapshot = snap;
          audit({
            action: "onboarding.prepared",
            pool: p!.id,
            intent: id,
            recipient,
          });
          return {
            id,
            token: secret,
            xdr: i.unsigned,
            expires,
            network: this.networkProfile.passphrase,
          };
        },
      );
    } finally {
      if (publicPoolId) this.publicObservations--;
    }
  }
  async submit(id: string, secret: string, returned: string) {
    const hot = await this.store.change(async (s, audit) => {
      const i = s.intents.find((i) => i.id === id);
      if (!i) return null;
      ensure(i.tokenHash === digest(secret), "Request unavailable", 404);
      if (i.state !== "AWAITING_SIGNATURE") return this.publicIntent(i);
      const p = this.pool(s, i.pool);
      ensure(p.status === "ACTIVE" && !s.haltReason, "Pool paused");
      ensure(
        i.admission === "public"
          ? p.access === "public"
          : p.allowlist.includes(i.recipient),
        "Address no longer allowed",
        403,
      );
      ensure(i.expires > now(), "Request expired");
      ensure(now() - s.workerAt < 90, "Worker unavailable");
      ensure(now() - (s.monitorAt ?? 0) < 90, "Reserve monitor unavailable");
      let tx: Transaction;
      try {
        tx = verifyRecipient(
          i.unsigned,
          returned,
          i.recipient,
          this.networkProfile.passphrase,
        );
      } catch {
        throw new Problem(400, "Invalid signature or modified transaction");
      }
      const d = day();
      // Enforced only after the recipient's own signature verified: nobody else
      // can spend this counter, and a failed institution signing rolls it back.
      const signedAttempt = retryKey("signed", d, i.recipient);
      p.prepares ??= {};
      ensure(
        (p.prepares[signedAttempt] ?? 0) < RECIPIENT_RETRY_LIMIT,
        "Recipient retry limit reached",
        429,
      );
      // If configured, apply the installation-wide public admission count
      // after recipient proof. Private invitations are not affected.
      const publicLimit = this.config.publicDailyAdmissions;
      if (i.admission === "public" && publicLimit != null)
        ensure(
          ((s.publicSigned ??= {})[d] ?? 0) < publicLimit,
          "Public admission limit reached today",
          429,
        );
      p.attempts[d] = (p.attempts[d] ?? 0) + 1;
      const outer = await this.signing.sign({
        kind: "onboard",
        network: this.networkProfile.passphrase,
        trustlineOnly: i.trustlineOnly,
        sponsor: i.sponsor,
        recipient: i.recipient,
        channel: i.channel,
        sequence: i.sequence,
        expires: i.expires,
        xdr: tx.toXdr(),
      });
      p.prepares[signedAttempt] = (p.prepares[signedAttempt] ?? 0) + 1;
      if (i.admission === "public")
        (s.publicSigned ??= {})[d] = (s.publicSigned[d] ?? 0) + 1;
      i.envelope = outer.toXdr();
      i.hash = hex(outer.hash());
      i.state = "READY";
      audit({ action: "onboarding.verified", pool: p.id, intent: id });
      return this.publicIntent(i);
    });
    if (hot) return hot;
    // Archived terminal rows answer replays with their final state; they are
    // never re-signed. Authentication is the same request token.
    const old = await this.store.archived(id);
    ensure(old && old.tokenHash === digest(secret), "Request unavailable", 404);
    return this.publicIntent(old!);
  }
  publicIntent(i: Intent) {
    return {
      id: i.id,
      recipient: i.recipient,
      kind: i.kind,
      state: i.state,
      hash: i.hash,
      landedHash: i.landedHash,
      ledger: i.ledger,
      fee: i.feeActual,
      reason: i.reason,
      expires: i.expires,
    };
  }
  async status(id: string, secret: string) {
    const s = await this.store.read();
    const i =
      s.intents.find((i) => i.id === id) ?? (await this.store.archived(id));
    ensure(i && i.tokenHash === digest(secret), "Request unavailable", 404);
    return this.publicIntent(i!);
  }
  private cooldown(s: State, recipient: string) {
    return s.intents.some(
      (i) =>
        i.recipient === recipient &&
        i.kind === "graduate" &&
        i.state === "FAILED" &&
        i.created > now() - GRADUATION_COOLDOWN,
    );
  }
  /** Maintenance guards that need no Horizon observation; run before I/O and again in the transaction. */
  private maintenanceGuards(
    s: State,
    poolId: string,
    recipient: string,
    target: string | undefined,
  ) {
    const p = this.pool(s, poolId);
    ensure(!s.haltReason, s.haltReason ?? "Halted");
    if (target && this.networkProfile.name === "mainnet")
      ensure(
        !this.sponsorAssigned(s, target, poolId),
        "Target sponsor account belongs to another mainnet pool",
      );
    if (!target)
      ensure(
        !this.cooldown(s, recipient),
        "Graduation failure cooldown: retry after 24 hours",
      );
    const record = p.sponsorships.find(
      (x) => x.recipient === recipient && x.units > 0,
    );
    ensure(record, "No active sponsorship");
    ensure(!target || target !== record!.sponsor, "Target is current sponsor");
    // Unsigned public holds naming this wallet are superseded in the
    // transaction; any other pending row blocks maintenance.
    ensure(
      !s.intents.some(
        (i) =>
          i.recipient === recipient &&
          pending(i) &&
          !(i.admission === "public" && i.state === "AWAITING_SIGNATURE"),
      ),
      "Maintenance already pending",
    );
    // Operate only on the entries this record owns. Other pools may hold
    // other entries of the same wallet under the same sponsor; those are
    // neither revoked nor transferred here.
    const entries = entriesOf(record!.units);
    // Fail closed on legacy double-booking: another record of any pool for
    // the same recipient and sponsor claiming an entry this record would
    // revoke or transfer would lose that entry without accounting for it.
    ensure(
      !s.pools.some((q) =>
        q.sponsorships.some(
          (x) =>
            x !== record &&
            x.recipient === recipient &&
            x.sponsor === record!.sponsor &&
            x.units > 0 &&
            unitsOf(intersectEntries(entries, entriesOf(x.units))) > 0,
        ),
      ),
      "Sponsorship ownership ambiguous",
    );
    ensure(
      this.config.channels.some(
        (c) => !s.intents.some((i) => i.channel === c && pending(i)),
      ),
      "Channels busy",
    );
    return { p, record: record!, entries };
  }
  async maintenance(poolId: string, recipient: string, target?: string) {
    if (target)
      ensure(
        this.config.sponsors.includes(target),
        "Unknown target sponsor",
        400,
      );
    return this.store.observedChange(
      async (state) => {
        const { record } = this.maintenanceGuards(
          state,
          poolId,
          recipient,
          target,
        );
        const selected = this.config.channels.find(
          (c) => !state.intents.some((i) => i.channel === c && pending(i)),
        )!;
        const snap = await this.chain.snapshot();
        const [user, ch, acc, payer] = await Promise.all([
          this.chain.account(recipient),
          this.channelAccount(selected, snap, state),
          this.chain.account(target ?? record.sponsor),
          this.chain.account(this.config.feePayer),
        ]);
        ensure(user, "Recipient missing");
        return { snap, user, ch, acc, payer };
      },
      async (s, { snap, user, ch, acc, payer }, audit) => {
        const { p, record, entries } = this.maintenanceGuards(
          s,
          poolId,
          recipient,
          target,
        );
        this.supersede(
          s,
          recipient,
          "Superseded by sponsor maintenance",
          audit,
        );
        const onChain = sponsored(
          user!,
          record.sponsor,
          this.networkProfile.issuer,
        );
        ensure(
          unitsOf(entries) > 0 && coversEntries(onChain, entries),
          "Sponsorship state changed",
        );
        if (!target)
          ensure(
            available(user!, BigInt(snap.reserve), unitsOf(entries)) >= 0n,
            "Recipient cannot cover reserve",
          );
        const channel = this.config.channels.find(
          (c) => !s.intents.some((i) => i.channel === c && pending(i)),
        );
        ensure(channel, "Channels busy");
        ensure(ch && acc && payer, "Funding unavailable");
        const cost = target
          ? BigInt(unitsOf(entries)) * BigInt(snap.reserve)
          : 0n;
        const opCount =
          (entries.account ? 1 : 0) +
          (entries.trustline ? 1 : 0) +
          (target ? 2 : 0);
        const fee = BigInt(this.config.baseFee * (opCount + 1));
        // A transfer replaces existing reserve: only physical B and fee capacity need additional reservation.
        const physical = s.intents
          .filter(
            (i) => pending(i) && (i.target ?? i.sponsor) === acc!.account_id,
          )
          .reduce((n, i) => n + BigInt(i.cost), 0n);
        ensure(
          available(acc!, BigInt(snap.reserve)) >= cost + physical,
          "Target reserve insufficient",
        );
        const poolFees = s.intents
          .filter((i) => pending(i) && i.pool === p.id)
          .reduce((n, i) => n + BigInt(i.feeReserve), 0n);
        ensure(
          BigInt(p.fees[day()] ?? "0") + poolFees + fee <= BigInt(p.feeCap),
          "Daily fee budget reached",
        );
        const allFees = s.intents
          .filter(pending)
          .reduce((n, i) => n + BigInt(i.feeReserve), 0n);
        ensure(
          available(payer!, BigInt(snap.reserve)) >= allFees + fee,
          "Fee payer insufficient",
        );
        ensure(
          snap.baseFee <= this.config.baseFee,
          "Network fee exceeds policy",
        );
        const expires = this.expiry();
        const tx = maintenance(
          {
            channel: channel!,
            sequence: ch!.sequence,
            sponsor: record.sponsor,
            recipient,
            expires,
          },
          target,
          entries,
          this.networkProfile,
        );
        const unsigned = tx.toXdr(),
          innerHash = hex(tx.hash());
        const outer = await this.signing.sign({
          kind: target ? "handover" : "graduate",
          network: this.networkProfile.passphrase,
          sponsor: record.sponsor,
          recipient,
          channel: channel!,
          sequence: tx.sequence,
          expires,
          target,
          entries,
          xdr: tx.toXdr(),
        });
        const i: Intent = {
          id: randomUUID(),
          pool: p.id,
          recipient,
          kind: target ? "handover" : "graduate",
          target,
          sponsor: record.sponsor,
          channel: channel!,
          sequence: tx.sequence,
          expires,
          state: "READY",
          unsigned,
          envelope: outer.toXdr(),
          innerHash,
          hash: hex(outer.hash()),
          tokenHash: "",
          cost: cost.toString(),
          feeReserve: fee.toString(),
          feeDay: day(),
          attempts: 0,
          created: now(),
          entries,
        };
        s.intents.push(i);
        audit({ action: i.kind + ".prepared", intent: i.id, recipient });
        return this.publicIntent(i);
      },
    );
  }
  async tick() {
    return this.store.workerLock(async () => {
      const snap = await this.chain.snapshot();
      await this.store.change((s, audit) => {
        if (s.snapshot && snap.ledger < s.snapshot.ledger) {
          s.haltReason =
            this.networkProfile.name === "testnet"
              ? "Ledger regression: inspect testnet reset"
              : "Ledger regression: inspect Horizon history before resuming";
          audit({ action: "network.halted", reason: s.haltReason });
        }
        s.snapshot = snap;
        s.workerAt = now();
        for (const i of s.intents)
          if (i.state === "AWAITING_SIGNATURE" && i.expires <= snap.closedAt) {
            i.state = "EXPIRED";
            audit({ action: "intent.expired", intent: i.id });
          }
      });
      let s = await this.store.read();
      if (s.haltReason) return;
      // Persistent outbox: mark before sending, and reconcile every ambiguous
      // response by hash. Every branch must finish before the worker lock is
      // released, otherwise an in-flight branch outlives its exclusion.
      const outcomes = await Promise.allSettled(
        s.intents.filter(signed).map((i) => this.settle(i, snap)),
      );
      const failure = outcomes.find((o) => o.status === "rejected");
      if (failure) throw (failure as PromiseRejectedResult).reason;
      // Coherent monitoring continues while signed envelopes are in flight:
      // their exact possible effects bound the expected counters instead of
      // blocking every other pool's reconciliation.
      await this.monitor();
      await this.archive();
      if (this.config.autoGraduate) await this.graduatePass();
    });
  }
  /**
   * Bounded, rotating automatic graduation. Only recipients whose last
   * coherent monitor reading could cover their reserve are attempted, at most
   * GRADUATIONS_PER_TICK per cycle, skipping pending, cooling-down and
   * ineligible records before any Horizon observation.
   */
  private async graduatePass() {
    const s = await this.store.read();
    const eligible = new Set(s.eligible ?? []);
    const candidates = s.pools.flatMap((p) =>
      p.sponsorships
        .filter(
          (r) =>
            r.units > 0 &&
            eligible.has(r.recipient) &&
            !this.cooldown(s, r.recipient) &&
            !s.intents.some(
              (i) =>
                i.recipient === r.recipient &&
                pending(i) &&
                !(i.admission === "public" && i.state === "AWAITING_SIGNATURE"),
            ),
        )
        .map((r) => ({ pool: p.id, recipient: r.recipient })),
    );
    if (!candidates.length) return;
    const start = (s.graduationCursor ?? 0) % candidates.length;
    const batch = Math.min(GRADUATIONS_PER_TICK, candidates.length);
    for (let k = 0; k < batch; k++) {
      const c = candidates[(start + k) % candidates.length];
      try {
        await this.maintenance(c.pool, c.recipient);
      } catch (e) {
        if (!(e instanceof Problem)) throw e;
      }
    }
    await this.store.change((st) => {
      st.graduationCursor = (start + batch) % Math.max(1, candidates.length);
    });
  }
  /**
   * Move old terminal rows out of hot state and prune expired per-day maps.
   * Pending rows, cooling-down failures, consumed lists, sponsorship records
   * and every audit row stay. Fee days referenced by pending intents, today
   * and yesterday are never pruned.
   */
  private async archive() {
    const at = now();
    const keepDay = new Date((at - ARCHIVE_AFTER) * 1000)
      .toISOString()
      .slice(0, 10);
    const s = await this.store.read();
    const dueRows = s.intents.some((i) => archivable(i, at));
    const staleKey = (k: string) => {
      const parts = k.split(":");
      const d = parts.length === 3 ? parts[1] : parts[0];
      return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < keepDay;
    };
    const dueMaps = s.pools.some(
      (p) =>
        Object.keys(p.attempts).some(staleKey) ||
        Object.keys(p.prepares ?? {}).some(staleKey) ||
        Object.keys(p.fees).some(staleKey),
    );
    if (!dueRows && !dueMaps) return;
    await this.store.change((st, audit, archive) => {
      const moved = st.intents.filter((i) => archivable(i, at));
      if (moved.length) {
        archive(moved);
        st.intents = st.intents.filter((i) => !archivable(i, at));
      }
      const referenced = new Set([
        day(),
        new Date(Date.now() - 86400000).toISOString().slice(0, 10),
        ...st.intents.filter(pending).map((i) => i.feeDay),
      ]);
      let pruned = 0;
      for (const p of st.pools) {
        for (const k of Object.keys(p.attempts))
          if (staleKey(k)) {
            delete p.attempts[k];
            pruned++;
          }
        for (const k of Object.keys(p.prepares ?? {}))
          if (staleKey(k)) {
            delete p.prepares![k];
            pruned++;
          }
        for (const k of Object.keys(p.fees))
          if (staleKey(k) && !referenced.has(k)) {
            delete p.fees[k];
            pruned++;
          }
      }
      if (moved.length || pruned)
        audit({
          action: "intents.archived",
          count: moved.length,
          prunedKeys: pruned,
          before: keepDay,
        });
    });
  }
  /**
   * The persisted row that a worker branch observed as `i`, only while it is
   * still the same signed envelope awaiting an outcome. Terminal rows and rows
   * re-signed under a different hash are never touched by a stale branch.
   */
  private signedRow(st: State, i: Intent) {
    const row = st.intents.find((x) => x.id === i.id);
    return row && signed(row) && row.hash === i.hash ? row : undefined;
  }
  /** Inner (recipient/institution-signed) transaction hash; derived for legacy rows. */
  private innerHashOf(i: Intent) {
    if (i.innerHash) return i.innerHash;
    const tx = TransactionBuilder.fromXdr(
      i.unsigned,
      this.networkProfile.passphrase,
    );
    return hex(tx.hash());
  }
  /**
   * Validate a Horizon result found by inner hash: the envelope must contain
   * exactly Cardea's immutable inner body (same signature base, same inner
   * hash under this network). A foreign fee-bump wrapper around that body is
   * accepted as the landing of this intent; its fee is Cardea's only when the
   * fee account is Cardea's own fee payer.
   */
  private landing(result: ChainResult, i: Intent, innerHash: string) {
    try {
      const env = TransactionBuilder.fromXdr(
        result.envelope_xdr,
        this.networkProfile.passphrase,
      );
      const inner =
        env instanceof FeeBumpTransaction ? env.innerTransaction : env;
      if (!(inner instanceof Transaction)) return null;
      if (hex(inner.hash()) !== innerHash) return null;
      const expected = TransactionBuilder.fromXdr(
        i.unsigned,
        this.networkProfile.passphrase,
      );
      if (
        !(expected instanceof Transaction) ||
        !Buffer.from(inner.signatureBase()).equals(
          Buffer.from(expected.signatureBase()),
        )
      )
        return null;
      const landed =
        env instanceof FeeBumpTransaction ? hex(env.hash()) : innerHash;
      if (
        result.inner_transaction &&
        result.inner_transaction.hash !== innerHash
      )
        return null;
      if (
        result.fee_bump_transaction &&
        result.fee_bump_transaction.hash !== landed
      )
        return null;
      if (result.hash !== innerHash && result.hash !== landed) return null;
      const feeSource =
        env instanceof FeeBumpTransaction ? env.feeSource : inner.source;
      if (result.fee_account && result.fee_account !== feeSource) return null;
      return { landed, chargeable: feeSource === this.config.feePayer };
    } catch {
      return null;
    }
  }
  /** Worker-internal: reconcile one signed intent observed as `i`. */
  async settle(i: Intent, snap: NetworkSnapshot) {
    let result = await this.chain.result(i.hash!);
    let landed = i.hash!,
      chargeable = true;
    if (!result) {
      // The same signed inner transaction may have reached the ledger inside
      // another wrapper. Horizon resolves it by inner hash; the returned
      // top-level hash is then the inner hash, never assumed to be the outer.
      const innerHash = this.innerHashOf(i);
      const byInner = await this.chain.result(innerHash);
      const match = byInner && this.landing(byInner, i, innerHash);
      if (match) {
        result = byInner;
        landed = match.landed;
        chargeable = match.chargeable;
      }
    }
    if (result) {
      await this.store.change((st, audit) => {
        const row = this.signedRow(st, i);
        if (!row) return;
        const p = this.pool(st, row.pool);
        ensure(
          result.created_at && Number.isFinite(Date.parse(result.created_at)),
          "Ledger inclusion time missing",
        );
        row.state = result.successful ? "CONFIRMED" : "FAILED";
        row.ledger = result.ledger;
        if (landed !== row.hash) row.landedHash = landed;
        row.feeActual = chargeable ? result.fee_charged : "0";
        row.reason = result.successful
          ? undefined
          : "Ledger rejected transaction";
        row.feeDay = new Date(result.created_at!).toISOString().slice(0, 10);
        p.fees[row.feeDay] = (
          BigInt(p.fees[row.feeDay] ?? "0") + BigInt(row.feeActual)
        ).toString();
        if (result.successful) this.book(p, row, result.ledger, audit);
        audit({
          action: "intent." + row.state.toLowerCase(),
          intent: row.id,
          hash: row.hash,
          landedHash: row.landedHash,
          fee: row.feeActual,
          ledger: row.ledger,
        });
      });
      return;
    }
    if (snap.closedAt > i.expires + 15) {
      const state = await this.store.read();
      const account = await this.channelAccount(i.channel, snap, state);
      await this.store.change((st, audit) => {
        const row = this.signedRow(st, i);
        if (!row) return;
        if (account && BigInt(account.sequence) < BigInt(row.sequence)) {
          row.state = "EXPIRED";
          row.reason = "Expired without ledger inclusion";
          audit({ action: "intent.expired", intent: row.id });
        } else {
          st.haltReason =
            "Consumed channel sequence without transaction history";
          audit({ action: "network.halted", intent: row.id });
        }
      });
      return;
    }
    if (now() - (i.lastAttempt ?? 0) >= 15 && i.expires > snap.closedAt) {
      // Submit only when this branch's transition to UNKNOWN actually applied;
      // a branch working from an older attempt must not resend or reset.
      const armed = await this.store.change((st) => {
        const row = this.signedRow(st, i);
        if (
          !row ||
          row.attempts !== i.attempts ||
          (row.lastAttempt ?? 0) !== (i.lastAttempt ?? 0) ||
          now() - (row.lastAttempt ?? 0) < 15
        )
          return false;
        row.state = "UNKNOWN";
        row.lastAttempt = now();
        row.attempts++;
        return true;
      });
      if (!armed) return;
      try {
        await this.chain.submit(i.envelope!);
      } catch {
        /* durable UNKNOWN, reconciled next tick */
      }
    }
  }
  /** Apply a successful ledger result to pool accounting, scoped to owned entries. */
  private book(
    p: Pool,
    row: Intent,
    ledger: number,
    audit: (event: Record<string, unknown>) => void,
  ) {
    if (row.kind === "onboard") {
      p.consumed.push(row.recipient);
      p.sponsorships.push({
        recipient: row.recipient,
        sponsor: row.sponsor,
        units: row.trustlineOnly ? 1 : 3,
        status: "ACTIVE",
        ledger,
      });
      return;
    }
    // The active record this maintenance was prepared from: same pool,
    // recipient and sponsor. Legacy intents without entries operated on the
    // whole record.
    const r = p.sponsorships.find(
      (x) =>
        x.recipient === row.recipient &&
        x.sponsor === row.sponsor &&
        x.units > 0,
    );
    if (!r) {
      audit({
        action: "sponsorship.unmatched",
        pool: p.id,
        intent: row.id,
        recipient: row.recipient,
        sponsor: row.sponsor,
      });
      return;
    }
    const owned = entriesOf(r.units);
    const moved: Entries = row.entries
      ? { account: row.entries.account, trustline: row.entries.trustline }
      : owned;
    r.ledger = ledger;
    if (row.target) {
      r.sponsor = row.target;
      r.status = "TRANSFERRED";
      return;
    }
    r.units = unitsOf({
      account: owned.account && !moved.account,
      trustline: owned.trustline && !moved.trustline,
    });
    if (r.units === 0) r.status = "GRADUATED";
  }
  /**
   * Downward reconciliation of one record against an observed recipient account:
   * an owned entry that the ledger no longer shows under the record's sponsor is
   * released. Never raises a claim.
   */
  private reconcileRecord(
    poolId: string,
    r: Sponsorship,
    account: ChainAccount | null,
    audit: (event: Record<string, unknown>) => void,
  ) {
    const owned = entriesOf(r.units);
    const onChain: Entries = account
      ? sponsored(account, r.sponsor, this.networkProfile.issuer)
      : { account: false, trustline: false };
    const actual = unitsOf(intersectEntries(owned, onChain));
    if (actual < r.units) {
      audit({
        action: "sponsorship.external_change",
        pool: poolId,
        recipient: r.recipient,
        before: r.units,
        after: actual,
      });
      r.units = actual;
      if (actual === 0) r.status = "CLOSED";
    }
  }
  private reconcileRecipient(
    s: State,
    recipient: string,
    account: ChainAccount | null,
    audit: (event: Record<string, unknown>) => void,
  ) {
    for (const p of s.pools)
      for (const r of p.sponsorships)
        if (r.recipient === recipient && r.units > 0)
          this.reconcileRecord(p.id, r, account, audit);
  }
  /**
   * Exact envelope of sponsor counters while signed envelopes are in flight:
   * each may still land or not, so the expected `num_sponsoring` lies in
   * [settled + all possible decreases, settled + all possible increases].
   */
  private sponsorBounds(s: State, sponsor: string) {
    const settled = s.pools
      .flatMap((p) => p.sponsorships)
      .filter((r) => r.sponsor === sponsor)
      .reduce((n, r) => n + r.units, 0);
    let lo = settled,
      hi = settled;
    for (const i of s.intents.filter(signed)) {
      const u = i.entries ? unitsOf(i.entries) : unitsOf(ALL_ENTRIES);
      if (i.kind === "onboard" && i.sponsor === sponsor)
        hi += i.trustlineOnly ? 1 : 3;
      if (i.kind === "graduate" && i.sponsor === sponsor) lo -= u;
      if (i.kind === "handover") {
        if (i.sponsor === sponsor) lo -= u;
        if (i.target === sponsor) hi += u;
      }
    }
    return { lo, hi };
  }
  async monitor() {
    const changed = Symbol("reserve state changed during observation");
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.store.read();
      const allocation = JSON.stringify([before.pools, before.intents]);
      const start = await this.chain.snapshot();
      const records = before.pools.flatMap((p) =>
        p.sponsorships
          .filter((r) => r.units > 0)
          .map((r) => ({
            pool: p.id,
            recipient: r.recipient,
            sponsor: r.sponsor,
            ledger: r.ledger,
          })),
      );
      if (records.some((r) => r.ledger > start.ledger)) continue;
      const [readings, sponsorReadings] = await Promise.all([
        mapLimit(records, HORIZON_FANOUT, async (r) => ({
          ...r,
          ...(await this.chain.accountWithLedger(r.recipient)),
        })),
        mapLimit(
          this.config.sponsors,
          HORIZON_FANOUT,
          async (a) => [a, await this.chain.accountWithLedger(a)] as const,
        ),
      ]);
      const end = await this.chain.snapshot();
      if (
        start.ledger !== end.ledger ||
        readings.some((r) => r.ledger !== start.ledger) ||
        sponsorReadings.some(([, r]) => r.ledger !== start.ledger)
      )
        continue;
      const accounts = new Map(
        sponsorReadings.map(([a, r]) => [a, r.account] as const),
      );
      const reserve = BigInt(start.reserve);
      try {
        await this.store.change((s, audit) => {
          if (JSON.stringify([s.pools, s.intents]) !== allocation)
            throw changed;
          // Recipients touched by signed in-flight operations are not reconciled
          // downward from this reading: the ledger may show either side of the
          // pending change. Everyone else is reconciled as usual.
          const touched = new Set(
            s.intents.filter(signed).map((i) => i.recipient),
          );
          const reductions = new Map<string, number>();
          for (const read of readings) {
            if (touched.has(read.recipient)) continue;
            const pool = this.pool(s, read.pool);
            for (const r of pool.sponsorships) {
              if (
                r.recipient !== read.recipient ||
                r.sponsor !== read.sponsor ||
                r.units === 0
              )
                continue;
              const observed = read.account
                ? sponsored(read.account, r.sponsor, this.networkProfile.issuer)
                : { account: false, trustline: false };
              const decrease =
                r.units -
                unitsOf(intersectEntries(entriesOf(r.units), observed));
              reductions.set(
                r.sponsor,
                (reductions.get(r.sponsor) ?? 0) + decrease,
              );
            }
          }
          const confirmed = new Set<string>();
          for (const [sponsor, decrease] of reductions) {
            if (decrease === 0) continue;
            if (
              s.intents.some(
                (i) =>
                  signed(i) && (i.sponsor === sponsor || i.target === sponsor),
              )
            )
              continue;
            const settled = s.pools
              .flatMap((pool) => pool.sponsorships)
              .filter((r) => r.sponsor === sponsor)
              .reduce((n, r) => n + r.units, 0);
            if (accounts.get(sponsor)?.num_sponsoring === settled - decrease)
              confirmed.add(sponsor);
          }
          s.monitorAt = now();
          const eligible: string[] = [];
          for (const read of readings) {
            const p = this.pool(s, read.pool);
            // Each record is reconciled against its own entries only; another
            // pool's record for the same wallet is a separate reading.
            for (const r of p.sponsorships)
              if (
                r.recipient === read.recipient &&
                r.sponsor === read.sponsor &&
                r.units > 0
              ) {
                if (!touched.has(r.recipient) && confirmed.has(r.sponsor))
                  this.reconcileRecord(p.id, r, read.account, audit);
                if (
                  r.units > 0 &&
                  read.account &&
                  available(read.account, reserve, r.units) >= 0n
                )
                  eligible.push(r.recipient);
              }
          }
          s.eligible = [...new Set(eligible)];
          for (const [a, account] of accounts) {
            const { lo, hi } = this.sponsorBounds(s, a);
            if (
              !account ||
              account.num_sponsoring < lo ||
              account.num_sponsoring > hi
            ) {
              for (const p of s.pools.filter(
                (p) =>
                  p.sponsor === a ||
                  p.sponsorships.some((r) => r.sponsor === a),
              )) {
                if (p.status === "ACTIVE") {
                  p.status = "PAUSED";
                  p.reason = "Unexplained sponsor reserve count";
                  audit({
                    action: "pool.auto_paused",
                    pool: p.id,
                    expected: lo === hi ? lo : { min: lo, max: hi },
                    actual: account?.num_sponsoring,
                  });
                }
              }
            }
          }
        });
      } catch (error) {
        if (error === changed) continue;
        throw error;
      }
      return;
    }
  }
  async dashboard() {
    const s = await this.store.read();
    const reserve = BigInt(s.snapshot?.reserve ?? "5000000");
    const sponsorAccounts = Object.fromEntries(
      await mapLimit(this.config.sponsors, HORIZON_FANOUT, async (id) => {
        try {
          const account = await this.chain.account(id);
          if (!account) return [id, null] as const;
          const balance = account.balances.find(
            (b) => b.asset_type === "native",
          );
          return [
            id,
            balance
              ? {
                  balance: units(balance.balance).toString(),
                  available: available(account, reserve).toString(),
                }
              : null,
          ] as const;
        } catch {
          // Balance display is advisory. Activation and signing independently
          // recheck the live ledger and must never trust this dashboard value.
          return [id, null] as const;
        }
      }),
    );
    return {
      network: this.networkProfile.passphrase,
      networkName: this.networkProfile.name,
      explorer: this.networkProfile.explorer,
      friendbot: this.networkProfile.friendbot,
      reserveCeiling: this.config.reserveCeiling
        ? units(this.config.reserveCeiling).toString()
        : null,
      committedReserve: this.globalReserve(s, reserve).toString(),
      workerHealthy: now() - s.workerAt < 90,
      haltReason: s.haltReason,
      snapshot: s.snapshot,
      sponsors: this.config.sponsors,
      assignedSponsors:
        this.networkProfile.name === "mainnet"
          ? this.config.sponsors.filter((id) => this.sponsorAssigned(s, id))
          : [],
      sponsorAccounts,
      feePayer: this.config.feePayer,
      pools: s.pools.map((p) => ({
        ...p,
        ...participation(s, p),
        links: p.allowlist.map((recipient) => ({
          recipient,
          token: this.invitation(p, recipient),
        })),
        pendingReserve: s.intents
          .filter((i) => i.pool === p.id && i.kind === "onboard" && pending(i))
          .reduce((n, i) => n + BigInt(i.cost), 0n)
          .toString(),
        activeReserve: (
          BigInt(p.sponsorships.reduce((n, r) => n + r.units, 0)) *
          BigInt(s.snapshot?.reserve ?? "5000000")
        ).toString(),
      })),
      intents: s.intents
        .slice(-100)
        .reverse()
        .map((i) => ({ ...this.publicIntent(i), pool: i.pool })),
      events: await this.store.events(),
    };
  }
}
