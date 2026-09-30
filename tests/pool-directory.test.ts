import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.ts";
import { server } from "../src/server.ts";
import { now, type PoolListing } from "../src/model.ts";

test("directory lists public and private pool metadata without invitations or wallets", async () => {
  const f = await fixture();
  try {
    const p2 = await f.app.createPool(
      "Community",
      f.config.sponsors[1],
      "100",
      "1",
      "Open for everyone",
      20,
    );
    await f.app.setAccess(p2.id, "public");
    const rows = (await f.app.directory()) as PoolListing[];
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      id: f.p.id,
      name: "Test",
      description: "",
      access: "private",
      participants: 0,
      pendingParticipants: 0,
      participantLimit: 50,
      availability: "open",
    });
    assert.equal(rows[1].availability, "paused");
    assert.equal(rows[1].description, "Open for everyone");
    assert.equal(rows[1].access, "public");
    for (const p of rows)
      assert.deepEqual(
        Object.keys(p).sort(),
        [
          "id",
          "name",
          "description",
          "access",
          "participants",
          "pendingParticipants",
          "participantLimit",
          "availability",
        ].sort(),
      );
    const json = JSON.stringify(rows);
    for (const secret of [
      f.p.invite,
      f.p.sponsor,
      f.users[0].publicKey(),
      f.app.invitation(f.p, f.users[0].publicKey()),
    ])
      assert.ok(!json.includes(secret));
    await assert.rejects(
      f.publicPrepare(f.users[0].publicKey(), f.p.id),
      /Invitation unavailable/,
    );
    await assert.rejects(f.app.directory("missing"), /Pool not found/);
  } finally {
    await f.close();
  }
});

test("last participant slot is reserved atomically for public and private pools", async () => {
  for (const access of ["public", "private"] as const) {
    const f = await fixture();
    try {
      await f.app.profile(f.p.id, "One place", "Last slot", 1);
      await f.app.setAccess(f.p.id, access);
      const attempts = await Promise.allSettled(
        [0, 1].map((n) =>
          access === "public"
            ? f.publicPrepare(f.users[n].publicKey(), f.p.id)
            : f.prepare(n),
        ),
      );
      const winner = attempts.findIndex((r) => r.status === "fulfilled");
      assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
      const rejected = attempts.find(
        (r) => r.status === "rejected",
      ) as PromiseRejectedResult;
      assert.match(rejected.reason.message, /participant limit/);
      let listing = (await f.app.directory(f.p.id)) as PoolListing;
      assert.equal(listing.participants, 0);
      assert.equal(listing.pendingParticipants, 1);
      assert.equal(listing.availability, "reserved");
      const success = attempts[winner] as PromiseFulfilledResult<
        Awaited<ReturnType<typeof f.prepare>>
      >;
      await f.sign(success.value, winner);
      await f.land();
      listing = (await f.app.directory(f.p.id)) as PoolListing;
      assert.equal(listing.participants, 1);
      assert.equal(listing.pendingParticipants, 0);
      assert.equal(listing.availability, "full");
      await assert.rejects(f.prepare(2), /participant limit/);
    } finally {
      await f.close();
    }
  }
});

test("zero public admissions disables public preparation and signing but preserves private invitations", async () => {
  const f = await fixture();
  try {
    await f.app.setAccess(f.p.id, "public");
    const pending = await f.publicPrepare(f.users[0].publicKey());
    f.config.publicDailyAdmissions = 0;
    assert.deepEqual(await f.app.publicPools(), []);
    assert.equal(
      ((await f.app.directory(f.p.id)) as PoolListing).availability,
      "unavailable",
    );
    await assert.rejects(
      f.publicPrepare(f.users[1].publicKey()),
      /Public onboarding is disabled/,
    );
    await assert.rejects(
      f.sign(pending),
      /Public admission limit reached today/,
    );
    assert.equal(
      (await f.store.read()).intents.find((i) => i.id === pending.id)?.state,
      "AWAITING_SIGNATURE",
    );
    await f.prepare(1);
  } finally {
    await f.close();
  }
});

test("expired preparations release participant capacity; pending requests prevent lowering cap", async () => {
  const f = await fixture();
  try {
    await f.app.profile(f.p.id, f.p.name, "", 2);
    await f.prepare(0);
    const second = await f.prepare(1);
    await assert.rejects(
      f.app.profile(f.p.id, f.p.name, "", 1),
      /below joined and pending/,
    );
    await f.store.change((s) => {
      s.intents.find((i) => i.id === second.id)!.expires = now() - 10;
    });
    await f.app.tick();
    const listing = (await f.app.directory(f.p.id)) as PoolListing;
    assert.equal(listing.pendingParticipants, 1);
    assert.equal(listing.availability, "open");
    await f.prepare(2);
    assert.equal(
      ((await f.app.directory(f.p.id)) as PoolListing).availability,
      "reserved",
    );
  } finally {
    await f.close();
  }
});

test("confirmed participants count once and remain counted after sponsorship graduation", async () => {
  const f = await fixture();
  try {
    await f.app.profile(f.p.id, f.p.name, "", 1);
    const r = await f.prepare();
    await f.sign(r);
    await f.land();
    const user = f.chain.accounts.get(f.users[0].publicKey())!;
    user.balances[0].balance = "10.0000000";
    await f.app.maintenance(f.p.id, user.account_id);
    await f.land();
    await f.store.change((s) => {
      s.pools[0].consumed.push(user.account_id);
    });
    const listing = (await f.app.directory(f.p.id)) as PoolListing;
    assert.equal(listing.participants, 1);
    assert.equal(listing.pendingParticipants, 0);
    assert.equal(listing.availability, "full");
    await assert.rejects(f.prepare(1), /participant limit/);
  } finally {
    await f.close();
  }
});

test("legacy pools keep their existing limits and remain visible during a health pause", async () => {
  const f = await fixture();
  try {
    await f.store.change((s) => {
      delete s.pools[0].participantLimit;
      delete s.pools[0].description;
      s.workerAt = 0;
      s.haltReason = "internal operator detail";
    });
    const listing = (await f.app.directory(f.p.id)) as PoolListing;
    assert.equal(listing.participantLimit, null);
    assert.equal(listing.description, "");
    assert.equal(listing.availability, "unavailable");
    assert.ok(!JSON.stringify(listing).includes("internal operator detail"));
    assert.equal(((await f.app.directory()) as PoolListing[]).length, 1);
  } finally {
    await f.close();
  }
});

test("directory HTTP routes are read-only and profile mutation validates auth, CSRF and limits", async () => {
  const f = await fixture();
  const http = await server(f.app);
  const profile = `/api/admin/pools/${f.p.id}/profile`;
  const payload = {
    name: "Updated name",
    description: "Pool description",
    participantLimit: 10,
  };
  try {
    const headers = { origin: f.config.origin };
    assert.equal(
      (await http.inject({ method: "POST", url: profile, payload, headers }))
        .statusCode,
      401,
    );
    const login = await http.inject({
      method: "POST",
      url: "/api/admin/login",
      headers,
      payload: { password: "test-operator-password-long" },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    assert.equal(
      (
        await http.inject({
          method: "POST",
          url: profile,
          payload,
          headers: { ...headers, cookie },
        })
      ).statusCode,
      403,
    );
    const authorized = {
      ...headers,
      cookie,
      "x-csrf-token": login.json().csrf,
    };
    for (const participantLimit of [0, -1, 1.5, 100001, "50"]) {
      const r = await http.inject({
        method: "POST",
        url: profile,
        headers: authorized,
        payload: { ...payload, participantLimit },
      });
      assert.equal(r.statusCode, 400);
    }
    const spoof = await http.inject({
      method: "POST",
      url: profile,
      headers: authorized,
      payload: { ...payload, consumed: [] },
    });
    assert.equal(spoof.statusCode, 400);
    assert.equal(
      (
        await http.inject({
          method: "POST",
          url: profile,
          headers: authorized,
          payload,
        })
      ).statusCode,
      200,
    );
    for (const url of [
      "/api/onboarding/directory",
      `/api/onboarding/directory/${f.p.id}`,
    ]) {
      const r = await http.inject({ method: "GET", url });
      assert.equal(r.statusCode, 200);
      assert.match(String(r.headers["cache-control"]), /no-store/);
      const data = Array.isArray(r.json()) ? r.json()[0] : r.json();
      assert.equal(data.name, payload.name);
      assert.equal(data.participantLimit, 10);
      assert.equal(data.access, "private");
    }
    assert.equal(
      (
        await http.inject({
          method: "GET",
          url: "/api/onboarding/directory/not-a-uuid",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await http.inject({
          method: "GET",
          url: "/api/onboarding/directory/00000000-0000-4000-8000-000000000000",
        })
      ).statusCode,
      404,
    );
  } finally {
    await http.close();
    await f.close();
  }
});
