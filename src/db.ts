import pg from "pg";
import { initial, type Intent, type State } from "./model.ts";
import { TESTNET, resolveNetwork } from "./network.ts";
export class Store {
  readonly db: pg.Pool;
  /**
   * @param network passphrase this store must be bound to. Defaults to testnet
   *   for local fixtures; production entrypoints always pass the resolved
   *   configured profile.
   */
  constructor(
    url: string,
    readonly namespace = "cardea",
    readonly network: string = TESTNET.passphrase,
  ) {
    resolveNetwork(network);
    this.db = new pg.Pool({
      connectionString: url,
      max: 15,
      connectionTimeoutMillis: 5000,
    });
  }
  async init() {
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS cardea_state (id text PRIMARY KEY, data jsonb NOT NULL); CREATE TABLE IF NOT EXISTS cardea_audit (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, namespace text NOT NULL, at timestamptz NOT NULL DEFAULT now(), event jsonb NOT NULL); CREATE TABLE IF NOT EXISTS cardea_archive (namespace text NOT NULL, id text NOT NULL, token_hash text NOT NULL, archived_at timestamptz NOT NULL DEFAULT now(), data jsonb NOT NULL, PRIMARY KEY (namespace, id));`,
    );
    await this.db.query(
      "INSERT INTO cardea_state VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [this.namespace, initial(this.network)],
    );
    await this.bind();
  }
  /**
   * Bind or verify the persisted network. A row written before network binding
   * existed carries no passphrase: if it holds data it can only have come from
   * the testnet-only releases, so it is adopted as testnet and never as
   * mainnet. A mainnet namespace must start empty; there is no migration.
   */
  private async bind() {
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout='20s'");
      const s = (
        await c.query("SELECT data FROM cardea_state WHERE id=$1 FOR UPDATE", [
          this.namespace,
        ])
      ).rows[0].data as State;
      if (s.network === undefined) {
        const populated =
          s.pools.length > 0 || s.intents.length > 0 || (s.revision ?? 0) > 0;
        if (populated && resolveNetwork(this.network).name !== "testnet")
          throw new Error(
            "Existing unbound state cannot be adopted by a mainnet installation; use a fresh namespace",
          );
        s.network = this.network;
        s.revision = (s.revision ?? 0) + 1;
        await c.query("UPDATE cardea_state SET data=$2 WHERE id=$1", [
          this.namespace,
          s,
        ]);
        await c.query(
          "INSERT INTO cardea_audit(namespace,event) VALUES ($1,$2)",
          [this.namespace, { action: "state.network_bound", network: s.network }],
        );
      } else if (s.network !== this.network)
        throw new Error(
          "Persistent state is bound to a different network than this configuration",
        );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async read(): Promise<State> {
    return (
      await this.db.query("SELECT data FROM cardea_state WHERE id=$1", [
        this.namespace,
      ])
    ).rows[0].data;
  }
  /**
   * Terminal intents that left hot state. Rows are keyed by namespace and
   * intent id and keep the request token digest so status lookups
   * authenticate exactly as they did while the row was hot.
   */
  async archived(id: string): Promise<Intent | null> {
    const r = await this.db.query(
      "SELECT data FROM cardea_archive WHERE namespace=$1 AND id=$2",
      [this.namespace, id],
    );
    return r.rows[0]?.data ?? null;
  }
  async change<T>(
    fn: (
      s: State,
      audit: (event: Record<string, unknown>) => void,
      /** Same transaction as the state update; used for the archive table. */
      archive: (intents: Intent[]) => void,
    ) => T | Promise<T>,
  ): Promise<T> {
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout='20s'");
      const s = (
        await c.query("SELECT data FROM cardea_state WHERE id=$1 FOR UPDATE", [
          this.namespace,
        ])
      ).rows[0].data as State;
      // Defense in depth: a row rebound by another process is never mutated here.
      if (s.network !== undefined && s.network !== this.network)
        throw new Error("Persistent state network mismatch");
      const events: Record<string, unknown>[] = [];
      const moved: Intent[] = [];
      const revision = s.revision ?? 0;
      const r = await fn(
        s,
        (e) => events.push(e),
        (intents) => moved.push(...intents),
      );
      s.revision = revision + 1;
      await c.query("UPDATE cardea_state SET data=$2 WHERE id=$1", [
        this.namespace,
        s,
      ]);
      for (const i of moved)
        await c.query(
          "INSERT INTO cardea_archive(namespace,id,token_hash,data) VALUES ($1,$2,$3,$4) ON CONFLICT (namespace,id) DO NOTHING",
          [this.namespace, i.id, i.tokenHash, i],
        );
      for (const e of events)
        await c.query(
          "INSERT INTO cardea_audit(namespace,event) VALUES ($1,$2)",
          [this.namespace, e],
        );
      await c.query("COMMIT");
      return r;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async observedChange<O, T>(
    observe: (state: State) => Promise<O>,
    apply: (
      state: State,
      observations: O,
      audit: (event: Record<string, unknown>) => void,
    ) => T | Promise<T>,
  ): Promise<T> {
    const conflict = Symbol("allocation state changed during observation");
    // Sessions and heartbeat timestamps do not affect allocation. Current health
    // is checked by apply; policy, reservations and reconciliation do affect it.
    const allocation = (s: State) =>
      JSON.stringify([s.pools, s.intents, s.haltReason]);
    for (let attempt = 0; attempt < 24; attempt++) {
      const before = await this.read();
      const observations = await observe(before); // No row lock while waiting on Horizon.
      try {
        return await this.change((state, audit) => {
          if (allocation(state) !== allocation(before)) throw conflict;
          return apply(state, observations, audit);
        });
      } catch (error) {
        if (error !== conflict) throw error;
      }
    }
    throw new Error("State busy; retry after checking request status");
  }
  async workerLock<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const c = await this.db.connect();
    try {
      const r = await c.query(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        ["worker:" + this.namespace],
      );
      if (!r.rows[0].locked) return;
      try {
        return await fn();
      } finally {
        await c.query("SELECT pg_advisory_unlock(hashtext($1))", [
          "worker:" + this.namespace,
        ]);
      }
    } finally {
      c.release();
    }
  }
  async events() {
    return (
      await this.db.query(
        "SELECT at,event FROM cardea_audit WHERE namespace=$1 ORDER BY id DESC LIMIT 100",
        [this.namespace],
      )
    ).rows;
  }
  async close() {
    await this.db.end();
  }
}
