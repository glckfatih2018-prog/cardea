import {
  t,
  getLanguage,
  setLanguage,
  initializeLanguage,
  subscribe,
  languages,
  names,
  languageLabels,
} from "./i18n.ts";
import React, { useState, useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  requestAccess,
  getAddress,
  getNetwork,
  signTransaction,
  isConnected,
} from "@stellar/freighter-api";
import "./style.css";
import type { PoolListing } from "../../src/model.ts";
import {
  getNetworkInfo,
  subscribeNetwork,
  loadNetworkInfo,
  revalidateNetworkInfo,
  networkLabel,
  networkBadge,
  explorerLink,
  friendbotLink,
  networkSpecificCopy,
  type NetworkInfo,
} from "./network.ts";
import { validatePreparedOnboarding } from "./onboarding-validation.ts";
const useNetwork = () => useSyncExternalStore(subscribeNetwork, getNetworkInfo);
const NETWORK_UNAVAILABLE =
  "Network information unavailable. Reload the page and try again.";
async function api(
  path: string,
  body?: unknown,
  csrf?: string,
  authorization?: string,
) {
  const res = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(authorization ? { Authorization: "Bearer " + authorization } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? t("Request failed"));
  return data;
}
const money = (v: string | number) =>
  new Intl.NumberFormat(getLanguage(), { maximumFractionDigits: 7 }).format(
    Number(v) / 1e7,
  );
const short = (v: string) => v.slice(0, 8) + "…" + v.slice(-6);
function Header() {
  const net = useNetwork();
  return (
    <header>
      <a className="brand" href="/">
        <img className="brand-mark" src="/logo.svg" alt="" aria-hidden="true" />
        <span>Cardea</span>
      </a>
      <nav>
        <label className="language-picker">
          <span className="sr-only">{languageLabels[getLanguage()]}</span>
          <select
            aria-label={languageLabels[getLanguage()]}
            value={getLanguage()}
            onChange={(e) =>
              setLanguage(e.target.value as (typeof languages)[number])
            }
          >
            {languages.map((lang) => (
              <option key={lang} value={lang} lang={lang}>
                {names[lang]}
              </option>
            ))}
          </select>
        </label>
        <span className="network">{t(networkLabel(net))}</span>
        <a href="/docs/">{t("Documentation")}</a>
        <a href="/app">
          {t("Open app")}
          <span aria-hidden>↗</span>
        </a>
      </nav>
    </header>
  );
}
function Footer() {
  const net = useNetwork();
  return (
    <footer>
      <span>{t("Cardea · Open-source sponsored onboarding")}</span>
      <a
        href="https://github.com/glckfatih2018-prog/cardea"
        target="_blank"
        rel="noreferrer"
      >
        GitHub ↗
      </a>
      <span>
        {t(
          networkSpecificCopy(
            net,
            "Real XLM reserves. Sponsorship covers reserves and fees only.",
            "Test assets only. No real funds.",
          ),
        )}
      </span>
    </footer>
  );
}
function Landing() {
  const net = useNetwork();
  return (
    <>
      <section className="hero">
        <p className="eyebrow">{t("An open door to Stellar")}</p>
        <h1>
          {t("A first payment")}
          <br />
          {t("shouldn’t need")}
          <br />
          <em>{t("a first deposit.")}</em>
        </h1>
        <p className="intro">
          {t(
            "Help your recipients get ready for USDC. Sponsor their account reserves while they keep control of their wallet.",
          )}
        </p>
        <div className="actions">
          <a className="button" href="/app">
            {t("Open the application ↗")}
          </a>
          <a href="/docs/">{t("How it works →")}</a>
        </div>
      </section>
      <section className="features">
        <article>
          <span>{t("01 / SPONSOR")}</span>
          <h2>
            {t("Keep the reserve.")}
            <br />
            {t("Open the door.")}
          </h2>
          <p>
            {t(
              "Create a pool, fund its dedicated sponsor account with only the XLM you choose, and set who may join. Sponsored reserves stay in the pool account until released.",
            )}
          </p>
        </article>
        <article>
          <span>{t("02 / RECIPIENT")}</span>
          <h2>
            {t("One connection.")}
            <br />
            {t("One signature.")}
          </h2>
          <p>
            {t(
              "Connect your own wallet and sign the prepared transaction. Your account and USDC trustline are created together, with zero XLM required.",
            )}
          </p>
        </article>
        <article>
          <span>{t("03 / RELEASE")}</span>
          <h2>
            {t("A reserve with")}
            <br />
            {t("a way back.")}
          </h2>
          <p>
            {t(
              "When a recipient can cover their own reserve, sponsorship can end. Another consenting sponsor can also take it over.",
            )}
          </p>
        </article>
      </section>
      <section className="note">
        <h2>{t("Built for a clear responsibility.")}</h2>
        <p>
          {t(
            networkSpecificCopy(
              net,
              "Cardea prepares accounts to receive USDC. It does not send payouts, hold recipient keys, or promise a return. This installation runs on the Stellar public network with real XLM reserves.",
              "Cardea prepares accounts to receive USDC. It does not send payouts, hold recipient keys, or promise a return. This release runs exclusively on Stellar testnet.",
            ),
          )}
        </p>
        <a href="/docs/">{t("Read the security model →")}</a>
      </section>
    </>
  );
}
function Notice({ error, message }: { error?: string; message?: string }) {
  return error ? (
    <p role="alert" className="notice error">
      {t(error)}
    </p>
  ) : message ? (
    <p role="status" className="notice">
      {t(message)}
    </p>
  ) : null;
}
function Dashboard() {
  const net = useNetwork();
  const [csrf, setCsrf] = useState(""),
    [password, setPassword] = useState(""),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState(""),
    [addresses, setAddresses] = useState(""),
    [target, setTarget] = useState(""),
    [inviteRecipient, setInviteRecipient] = useState("");
  const refresh = async () => {
    const d = await api("/admin/dashboard");
    setData(d);
    setSelected((x) => x || d.pools[0]?.id || "");
  };
  useEffect(() => {
    api("/admin/session")
      .then((s) => {
        setCsrf(s.csrf);
        return refresh();
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!csrf) return;
    const t = setInterval(
      () => refresh().catch((e) => setError(e.message)),
      5000,
    );
    return () => clearInterval(t);
  }, [csrf]);
  const act = async (fn: () => Promise<unknown>, success = "Saved") => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await refresh();
      setMessage(success);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!csrf)
    return (
      <main className="login">
        <p className="eyebrow">{t("Organization access")}</p>
        <h1>
          {t("Your sponsorship")}
          <br />
          <em>{t("workspace.")}</em>
        </h1>
        <p>
          {t(
            "This area is for the organization managing this installation. Recipients use their invitation link and do not need a password.",
          )}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              const r = await api("/admin/login", { password });
              setCsrf(r.csrf);
              setPassword("");
            }, "Signed in");
          }}
        >
          <label>
            {t("Organization password")}
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button disabled={busy}>{t("Sign in →")}</button>
        </form>
        <Notice error={t(error)} />
        <a href="/docs/">{t("Organization setup guide →")}</a>
      </main>
    );
  const p = data?.pools.find((p: any) => p.id === selected);
  const availableSponsors = (net && data?.sponsors ? data.sponsors : []).filter(
    (s: string) =>
      net?.name !== "mainnet" ||
      (Array.isArray(data.assignedSponsors) &&
        !data.assignedSponsors.includes(s)),
  );
  const chosenLink =
    p?.links?.find((l: any) => l.recipient === inviteRecipient) ??
    p?.links?.[0];
  const invitationLink = chosenLink
    ? location.origin + "/onboard/" + chosenLink.token
    : "";
  const list = () => addresses.split(/[\s,;]+/).filter(Boolean);
  return (
    <main className="workspace">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t("Organization workspace")}</p>
          <h1>{t("Sponsorship pools")}</h1>
        </div>
        <button
          className="secondary"
          onClick={async () => {
            setError("");
            try {
              await api("/admin/logout", {}, csrf);
              setCsrf("");
              setData(null);
              setMessage("");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          {t("Sign out")}
        </button>
      </div>
      <Notice error={t(error)} message={t(message)} />
      {data && !data.workerHealthy && (
        <Notice
          error={t(
            "Worker is unavailable. New onboarding is blocked until it recovers.",
          )}
        />
      )}
      {data?.haltReason && <Notice error={data.haltReason} />}
      <div className="workspace-grid">
        <aside>
          <h2>{t("Your pools")}</h2>
          <div className="pool-list">
            {data?.pools.map((p: any) => (
              <button
                className={p.id === selected ? "selected" : "secondary"}
                key={p.id}
                onClick={() => setSelected(p.id)}
              >
                {p.name}
                <small>{t(p.status)}</small>
              </button>
            ))}
          </div>
          <details open={!data?.pools.length && availableSponsors.length > 0}>
            <summary>{t("Create a pool")}</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                act(async () => {
                  const r = await api(
                    "/admin/pools",
                    {
                      ...Object.fromEntries(fd),
                      participantLimit: Number(fd.get("participantLimit")),
                    },
                    csrf,
                  );
                  setSelected(r.id);
                }, "Pool created. Add recipients, then activate.");
              }}
            >
              <label>
                {t("Pool name")}
                <input
                  name="name"
                  required
                  maxLength={80}
                  placeholder={t("September grants")}
                />
              </label>
              <label>
                {t("Sponsor")}
                <select name="sponsor">
                  {availableSponsors.map((s: string) => (
                    <option value={s} key={s}>
                      {short(s)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("Pool description")}
                <textarea name="description" rows={3} maxLength={1000} />
              </label>
              <label>
                {t("Participant limit")}
                <input
                  name="participantLimit"
                  type="number"
                  min="1"
                  max="100000"
                  step="1"
                  defaultValue="50"
                  required
                />
              </label>
              <label>
                {t("Reserve limit (XLM)")}
                <input
                  name="cap"
                  type="number"
                  step="0.0000001"
                  min="1.5"
                  defaultValue={net?.name === "testnet" ? "75" : "15"}
                  required
                />
              </label>
              <label>
                {t("Daily fee limit (XLM)")}
                <input
                  name="feeCap"
                  type="number"
                  step="0.0000001"
                  min="0.001"
                  defaultValue={net?.name === "testnet" ? "1" : "0.02"}
                  required
                />
              </label>
              <button disabled={busy || availableSponsors.length === 0}>
                {t("Create pool")}
              </button>
              {net?.name === "mainnet" && availableSponsors.length === 0 && (
                <p className="muted">
                  {t(
                    "Each mainnet pool needs its own configured sponsor account. Ask the installation operator to add a separate account before creating another pool.",
                  )}
                </p>
              )}
            </form>
          </details>
        </aside>
        <section>
          {p ? (
            <>
              <div className="pool-heading">
                <h2>{p.name}</h2>
                <span className={"badge " + p.status.toLowerCase()}>
                  {t(p.status)}
                </span>
                <button
                  disabled={busy}
                  onClick={() =>
                    act(
                      () =>
                        api(
                          `/admin/pools/${p.id}/policy`,
                          { active: p.status !== "ACTIVE" },
                          csrf,
                        ),
                      p.status === "ACTIVE"
                        ? "New onboarding paused"
                        : "Pool activated",
                    )
                  }
                >
                  {p.status === "ACTIVE"
                    ? t("Pause onboarding")
                    : t("Activate pool")}
                </button>
              </div>
              {p.reason && <p className="muted">{t(p.reason)}</p>}
              <details className="panel">
                <summary>{t("Pool details and participants")}</summary>
                <p>
                  {t("Participants")}: {p.participants} /{" "}
                  {p.participantLimit ?? t("No set limit")}
                </p>
                <p className="muted">
                  {t("Pending applications")}: {p.pendingParticipants}
                </p>
                <form
                  key={p.id}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const fd = new FormData(e.currentTarget);
                    act(() =>
                      api(
                        `/admin/pools/${p.id}/profile`,
                        {
                          name: fd.get("name"),
                          description: fd.get("description"),
                          participantLimit:
                            fd.get("participantLimit") === ""
                              ? null
                              : Number(fd.get("participantLimit")),
                        },
                        csrf,
                      ),
                    );
                  }}
                >
                  <label>
                    {t("Pool name")}
                    <input
                      name="name"
                      maxLength={80}
                      required
                      defaultValue={p.name}
                    />
                  </label>
                  <label>
                    {t("Pool description")}
                    <textarea
                      name="description"
                      maxLength={1000}
                      rows={4}
                      defaultValue={p.description ?? ""}
                    />
                  </label>
                  <label>
                    {t("Participant limit")}
                    <input
                      name="participantLimit"
                      type="number"
                      min="1"
                      max="100000"
                      step="1"
                      defaultValue={p.participantLimit ?? ""}
                    />
                  </label>
                  <p className="muted">
                    {t(
                      "Leave empty for no participant limit. Completed participants and pending applications count towards the limit.",
                    )}
                  </p>
                  <p className="muted">
                    {t(
                      "Pool names, descriptions and participant counts are visible in the directory, including private pools. Wallet addresses and invitation links stay private.",
                    )}
                  </p>
                  <button disabled={busy}>{t("Save pool details")}</button>
                </form>
              </details>
              <div className="stats">
                <article>
                  <small>{t("Active reserve")}</small>
                  <strong>
                    {money(p.activeReserve)} <i>XLM</i>
                  </strong>
                </article>
                <article>
                  <small>{t("Reserved for pending")}</small>
                  <strong>
                    {money(p.pendingReserve)} <i>XLM</i>
                  </strong>
                </article>
                <article>
                  <small>{t("Pool limit")}</small>
                  <strong>
                    {money(p.cap)} <i>XLM</i>
                  </strong>
                </article>
                <article>
                  <small>{t("Fees today / limit")}</small>
                  <strong>
                    {money(p.fees[new Date().toISOString().slice(0, 10)] ?? 0)}{" "}
                    <i>/ {money(p.feeCap)} XLM</i>
                  </strong>
                </article>
              </div>
              <details className="panel">
                <summary>{t("Adjust pool limits")}</summary>
                <form
                  key={p.id}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const fd = new FormData(e.currentTarget);
                    act(
                      () =>
                        api(
                          "/admin/pools/" + p.id + "/limits",
                          Object.fromEntries(fd),
                          csrf,
                        ),
                      "Limits updated",
                    );
                  }}
                >
                  <label>
                    {t("Reserve limit (XLM)")}
                    <input
                      required
                      name="cap"
                      type="number"
                      step="0.0000001"
                      min="0.0000001"
                      defaultValue={Number(p.cap) / 1e7}
                    />
                  </label>
                  <label>
                    {t("Daily fee limit (XLM)")}
                    <input
                      required
                      name="feeCap"
                      type="number"
                      step="0.0000001"
                      min="0.0000001"
                      defaultValue={Number(p.feeCap) / 1e7}
                    />
                  </label>
                  <button disabled={busy}>{t("Save limits")}</button>
                </form>
              </details>
              <div className="panel">
                <label>
                  {t("Pool access")}
                  <select
                    value={p.access ?? "private"}
                    disabled={busy}
                    onChange={(e) =>
                      act(
                        () =>
                          api(
                            "/admin/pools/" + p.id + "/access",
                            { access: e.target.value },
                            csrf,
                          ),
                        "Access updated",
                      )
                    }
                  >
                    <option value="private">{t("Invitation only")}</option>
                    <option value="public">
                      {t("Public — no invitation required")}
                    </option>
                  </select>
                </label>
                <p className="muted">
                  {t(
                    "Public pools accept any eligible wallet within your reserve and fee limits.",
                  )}
                </p>
                <h3>{t("Invite your recipients")}</h3>
                <p>
                  {t(
                    "Each invitation is bound to one allowed recipient. Share only that recipient’s link.",
                  )}
                </p>
                <label>
                  {t("Invitation recipient")}
                  <select
                    value={chosenLink?.recipient ?? ""}
                    onChange={(e) => setInviteRecipient(e.target.value)}
                  >
                    {p.links?.map((l: any) => (
                      <option key={l.recipient} value={l.recipient}>
                        {short(l.recipient)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="copyrow">
                  <input
                    aria-label={t("Invitation link")}
                    readOnly
                    value={invitationLink}
                  />
                  <button
                    disabled={!chosenLink}
                    className="secondary"
                    onClick={() =>
                      navigator.clipboard
                        .writeText(invitationLink)
                        .then(() => setMessage("Invitation copied"))
                        .catch(() => setError("Copy the link manually"))
                    }
                  >
                    {t("Copy link")}
                  </button>
                </div>
                <button
                  className="textbutton"
                  onClick={() =>
                    act(
                      () => api(`/admin/pools/${p.id}/invite`, {}, csrf),
                      "Old invitation invalidated",
                    )
                  }
                >
                  {t("Replace invitation link")}
                </button>
              </div>
              <div className="panel">
                <h3>
                  {t("Allowlist")}{" "}
                  <span className="muted">
                    {p.allowlist.length}
                    {t("addresses")}
                  </span>
                </h3>
                <label>
                  {t("Addresses, one per line")}
                  <textarea
                    rows={4}
                    value={addresses}
                    onChange={(e) => setAddresses(e.target.value)}
                    placeholder="G…"
                  />
                </label>
                <label className="filelabel">
                  {t("Import a CSV or text file")}
                  <input
                    type="file"
                    accept=".csv,.txt"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        if (file.size > 30000) {
                          setError("File must be under 30 KB");
                          return;
                        }
                        setAddresses(await file.text());
                      }
                    }}
                  />
                </label>
                <div className="actions">
                  <button
                    disabled={busy || !addresses.trim()}
                    onClick={() =>
                      act(
                        () =>
                          api(
                            `/admin/pools/${p.id}/allowlist`,
                            { addresses: list() },
                            csrf,
                          ),
                        "Allowlist updated",
                      )
                    }
                  >
                    {t("Add addresses")}
                  </button>
                  <button
                    disabled={busy || !addresses.trim()}
                    className="secondary"
                    onClick={() =>
                      act(
                        () =>
                          api(
                            `/admin/pools/${p.id}/allowlist`,
                            { addresses: list(), remove: true },
                            csrf,
                          ),
                        "Addresses removed",
                      )
                    }
                  >
                    {t("Remove addresses")}
                  </button>
                </div>
              </div>
              <div className="panel">
                <h3>{t("Sponsored recipients")}</h3>
                <p>
                  {t(
                    "Reserves are released automatically when a recipient can support their account. A handover needs the new sponsor’s configured signing authority.",
                  )}
                </p>
                <label>
                  {t("Handover destination")}
                  <select
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="">{t("Choose sponsor")}</option>
                    {data.sponsors.map((a: string) => (
                      <option value={a} key={a}>
                        {short(a)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("Recipient")}</th>
                        <th>{t("Reserve")}</th>
                        <th>{t("State")}</th>
                        <th>{t("Action")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.sponsorships.map((r: any) => (
                        <tr key={r.recipient}>
                          <td>
                            {net ? (
                              <a
                                href={explorerLink(net, "account", r.recipient)}
                                target="_blank"
                                rel="noreferrer"
                                title={r.recipient}
                              >
                                {short(r.recipient)} ↗
                              </a>
                            ) : (
                              <span title={r.recipient}>
                                {short(r.recipient)}
                              </span>
                            )}
                          </td>
                          <td>
                            {money(
                              r.units *
                                Number(data.snapshot?.reserve ?? 5000000),
                            )}{" "}
                            XLM
                          </td>
                          <td>{t(r.status)}</td>
                          <td>
                            <button
                              className="secondary"
                              disabled={
                                busy ||
                                !r.units ||
                                !target ||
                                target === r.sponsor
                              }
                              onClick={() =>
                                act(
                                  () =>
                                    api(
                                      `/admin/pools/${p.id}/handover`,
                                      { recipient: r.recipient, target },
                                      csrf,
                                    ),
                                  "Handover queued",
                                )
                              }
                            >
                              {t("Handover")}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!p.sponsorships.length && (
                    <p className="empty">{t("No sponsored recipients yet.")}</p>
                  )}
                </div>
              </div>
              <div className="panel">
                <h3>{t("Funding & network")}</h3>
                <p>
                  {t("Sponsor account:")} <code>{p.sponsor}</code>
                </p>
                {net?.name === "mainnet" && (
                  <>
                    <p className="muted">
                      {t(
                        "Send only the XLM amount you choose from your personal wallet to this dedicated pool account. Cardea does not receive signing permission for your personal wallet. The pool account is controlled by this installation's signer and its XLM can be used for sponsorship until the configured limits or funds run out.",
                      )}
                    </p>
                    <button
                      className="secondary"
                      onClick={() =>
                        navigator.clipboard.writeText(p.sponsor).then(
                          () => setMessage("Pool account address copied"),
                          () =>
                            setError("Copy the pool account address manually"),
                        )
                      }
                    >
                      {t("Copy pool account address")}
                    </button>
                    <p>
                      {t("Pool account balance:")}{" "}
                      {data.sponsorAccounts?.[p.sponsor]
                        ? money(data.sponsorAccounts[p.sponsor].balance) +
                          " XLM"
                        : t("Unfunded or balance unavailable")}
                    </p>
                    <p>
                      {t("Available after Stellar reserves:")}{" "}
                      {data.sponsorAccounts?.[p.sponsor]
                        ? money(data.sponsorAccounts[p.sponsor].available) +
                          " XLM"
                        : t("Unfunded or balance unavailable")}
                    </p>
                    <p className="muted">
                      {t(
                        "The reserve limit is an application policy, not a wallet spending allowance. Keep only the amount you intend to sponsor in this account; existing sponsored reserves stay locked until released or transferred.",
                      )}
                    </p>
                  </>
                )}
                <p>
                  <span className="badge">{t(networkBadge(net))}</span>
                </p>
                {net && friendbotLink(net, p.sponsor) && (
                  <a
                    href={friendbotLink(net, p.sponsor)!}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("Fund with test XLM ↗")}
                  </a>
                )}
                {data.reserveCeiling && (
                  <p className="muted">
                    {t("Installation reserve ceiling:")}{" "}
                    {money(data.committedReserve)} /{" "}
                    {money(data.reserveCeiling)} XLM
                  </p>
                )}
                <p>
                  {t("Latest ledger:")} {data.snapshot?.ledger ?? t("Waiting")}
                  {t("· Reserve unit:")}
                  {money(data.snapshot?.reserve ?? 5000000)} XLM
                </p>
              </div>
            </>
          ) : (
            <div className="empty">
              <h2>{t("Create your first pool")}</h2>
              <p>
                {t("Choose a sponsor, set a reserve limit and add recipients.")}
              </p>
            </div>
          )}
        </section>
      </div>
      <section className="panel">
        <h2>{t("Recent activity")}</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>{t("Recipient")}</th>
                <th>{t("Operation")}</th>
                <th>{t("State")}</th>
                <th>{t("Transaction")}</th>
              </tr>
            </thead>
            <tbody>
              {data?.intents.map((i: any) => (
                <tr key={i.id}>
                  <td title={i.recipient}>{short(i.recipient)}</td>
                  <td>{t(i.kind)}</td>
                  <td>
                    {t(i.state)}
                    {i.reason && <small>{t(i.reason)}</small>}
                  </td>
                  <td>
                    {i.hash ? (
                      net ? (
                        <a
                          target="_blank"
                          rel="noreferrer"
                          href={explorerLink(net, "tx", i.landedHash ?? i.hash)}
                        >
                          {short(i.landedHash ?? i.hash)} ↗
                        </a>
                      ) : (
                        short(i.landedHash ?? i.hash)
                      )
                    ) : (
                      t("Awaiting signature")
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details>
          <summary>{t("Audit events")}</summary>
          <ul>
            {data?.events.map((e: any, n: number) => (
              <li key={n}>
                <time>{new Date(e.at).toLocaleString()}</time> ·{" "}
                {e.event.action}
                {e.event.reason ? " · " + e.event.reason : ""}
              </li>
            ))}
          </ul>
        </details>
      </section>
    </main>
  );
}
function Onboard({ poolId }: { poolId?: string }) {
  const net = useNetwork();
  const invite = location.pathname.split("/")[2];
  const requestKey = poolId ? "public:" + poolId : invite;
  const [recipient, setRecipient] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [request, setRequest] = useState<any>(() => {
      try {
        const cached = JSON.parse(
          sessionStorage.getItem("cardea-request:" + requestKey) ?? "null",
        );
        // A cached request carries the passphrase it was prepared for. Never
        // reuse one prepared for another network than the server reports now.
        const n = getNetworkInfo();
        if (cached && (!n || cached.network !== n.passphrase)) {
          sessionStorage.removeItem("cardea-request:" + requestKey);
          return null;
        }
        return cached;
      } catch {
        return null;
      }
    }),
    [status, setStatus] = useState<any>(null);
  const switchMessage = (n: NetworkInfo) =>
    n.name === "mainnet"
      ? "Switch Freighter to Stellar Mainnet (Public network), then connect again."
      : "Switch Freighter to Stellar Testnet, then connect again.";
  useEffect(() => {
    if (!request || !recipient || request.recipient !== recipient) return;
    let active = true;
    const poll = () =>
      api(
        `/onboarding/${request.id}/status`,
        undefined,
        undefined,
        request.token,
      )
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    poll();
    const t = setInterval(poll, 4000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [request, recipient]);
  useEffect(() => {
    let active = true;
    const checkWallet = async () => {
      if (busy) return;
      try {
        const [wallet, network] = await Promise.all([
          getAddress(),
          getNetwork(),
        ]);
        if (!active) return;
        const address = wallet.error ? "" : wallet.address;
        const onCorrectNetwork =
          !!net && network.networkPassphrase === net.passphrase;
        if (request && address && request.recipient !== address) {
          sessionStorage.removeItem("cardea-request:" + requestKey);
          setRequest(null);
          setStatus(null);
          setRecipient("");
        } else if (request && (!address || !onCorrectNetwork)) {
          setRecipient("");
          setStatus(null);
        } else if (request && !recipient && onCorrectNetwork) {
          setRecipient(address);
        } else if (recipient && (recipient !== address || !onCorrectNetwork)) {
          setRecipient("");
          setStatus(null);
        }
      } catch {
        if (active) {
          setStatus(null);
          setRecipient("");
        }
      }
    };
    void checkWallet();
    const interval = setInterval(checkWallet, 4000);
    window.addEventListener("focus", checkWallet);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener("focus", checkWallet);
    };
  }, [net, request, recipient, requestKey, busy]);
  const connect = async () => {
    setError("");
    setBusy(true);
    try {
      if (!net) throw new Error(NETWORK_UNAVAILABLE);
      const c = await isConnected();
      if (!c.isConnected)
        throw new Error(
          net.name === "mainnet"
            ? "Install or unlock Freighter to connect your Stellar wallet."
            : "Install or unlock Freighter to connect your Stellar testnet wallet.",
        );
      const a = await requestAccess();
      if (a.error || !a.address)
        throw new Error("Wallet connection was not approved.");
      const n = await getNetwork();
      // The wallet must already be on the server's network. Cardea never asks
      // the wallet to switch networks on the recipient's behalf.
      if (n.networkPassphrase !== net.passphrase)
        throw new Error(switchMessage(net));
      if (request && request.recipient && request.recipient !== a.address) {
        setRequest(null);
        setStatus(null);
        sessionStorage.removeItem("cardea-request:" + requestKey);
      }
      setRecipient(a.address);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sign = async () => {
    setError("");
    setBusy(true);
    try {
      if (!net) throw new Error(NETWORK_UNAVAILABLE);
      // Revalidate the server profile at signing time; stale metadata from a
      // page left open must never select the signing network.
      const fresh = await revalidateNetworkInfo();
      const n = await getNetwork();
      if (n.networkPassphrase !== fresh.passphrase)
        throw new Error(switchMessage(fresh));
      const wallet = await getAddress();
      if (wallet.error || wallet.address !== recipient)
        throw new Error("Wallet changed. Connect the current wallet again.");
      let r = request;
      if (
        !r ||
        r.network !== fresh.passphrase ||
        ["EXPIRED", "REJECTED", "FAILED"].includes(status?.state) ||
        r.expires < Date.now() / 1000
      ) {
        r = await api(
          "/onboarding/prepare",
          poolId ? { pool: poolId, recipient } : { invite, recipient },
        );
        r = { ...r, recipient };
        setStatus(null);
        setRequest(r);
        sessionStorage.setItem(
          "cardea-request:" + requestKey,
          JSON.stringify(r),
        );
      }
      // Three parties must agree on the passphrase before signing: the server
      // profile, the prepared request and the wallet. Any mismatch stops here.
      if (r.network !== fresh.passphrase)
        throw new Error(
          "Prepared request belongs to a different network. Reload the page.",
        );
      validatePreparedOnboarding(r, recipient, fresh);
      const signed = await signTransaction(r.xdr, {
        networkPassphrase: fresh.passphrase,
        address: recipient,
      });
      if (signed.error || !signed.signedTxXdr)
        throw new Error(
          "Signature declined. No sponsorship was submitted. You can retry before the request expires.",
        );
      setStatus(
        await api(`/onboarding/${r.id}/submit`, {
          token: r.token,
          xdr: signed.signedTxXdr,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const statusForWallet =
    !!request && !!recipient && request.recipient === recipient && !!status;
  const success = statusForWallet && status.state === "CONFIRMED";
  const pending =
    statusForWallet && ["READY", "UNKNOWN"].includes(status.state);
  return (
    <main className="recipient">
      {poolId && (
        <a className="back-link" href={"/receive/" + poolId}>
          {t("← Pool details")}
        </a>
      )}
      <p className="eyebrow">{t("A sponsored start")}</p>
      <h1>
        {success ? (
          <>
            {t("Your account")}
            <br />
            {t("is")} <em>{t("ready.")}</em>
          </>
        ) : (
          <>
            {t("Ready for USDC.")}
            <br />
            <em>{t("No XLM needed.")}</em>
          </>
        )}
      </h1>
      <p className="intro">
        {success
          ? t(
              "Your account and USDC trustline are active. Your wallet remains under your control.",
            )
          : t(
              "Your sponsor covers the reserve and network fee. Connect your own wallet, review the transaction and sign once.",
            )}
      </p>
      <ol className="steps">
        <li>
          {t(
            networkSpecificCopy(
              net,
              "Connect your Stellar wallet",
              "Connect your testnet wallet",
            ),
          )}
        </li>
        <li>{t("Approve one transaction")}</li>
        <li>{t("Receive your account confirmation")}</li>
      </ol>
      <Notice error={t(error)} />
      {!net && <Notice error={t(NETWORK_UNAVAILABLE)} />}
      {recipient && <p className="address">{recipient}</p>}
      {recipient && !success && (
        <p className="muted" role="note">
          {t(
            "Freighter may warn that a zero-XLM wallet cannot pay a fee. The sponsor pays the final network fee. Continue only if the wallet shows the correct network, the expected sponsorship and USDC trustline operations, and a 0 XLM fee; otherwise cancel.",
          )}
        </p>
      )}
      {!success && !pending && (
        <div className="actions">
          {!recipient ? (
            <button disabled={busy || !net} onClick={connect}>
              {t("Connect Freighter →")}
            </button>
          ) : (
            <>
              <button disabled={busy || !net} onClick={sign}>
                {busy ? t("Waiting for wallet…") : t("Review & sign")}
              </button>
              <button
                className="secondary"
                disabled={busy || !net}
                onClick={connect}
              >
                {t("Change wallet")}
              </button>
            </>
          )}
        </div>
      )}
      {pending && (
        <p role="status" className="notice">
          {t(
            "Waiting for ledger confirmation. You can safely refresh this page.",
          )}
        </p>
      )}
      {success && (
        <button className="secondary" disabled={busy || !net} onClick={connect}>
          {t("Change wallet")}
        </button>
      )}
      {statusForWallet && (
        <div className="panel">
          <strong>{t(status.state)}</strong>
          {status.reason && <p>{t(status.reason)}</p>}
          {status.hash && net && (
            <p>
              <a
                href={explorerLink(net, "tx", status.landedHash ?? status.hash)}
                target="_blank"
                rel="noreferrer"
              >
                {t("View transaction ↗")}
              </a>
            </p>
          )}
        </div>
      )}
      <p className="muted">
        {t(
          networkSpecificCopy(
            net,
            "Cardea never asks for your recovery phrase or private key. This is Stellar mainnet: your sponsor locks real XLM reserves for you.",
            "Cardea never asks for your recovery phrase or private key. This is Stellar testnet.",
          ),
        )}
      </p>
    </main>
  );
}
function Documentation() {
  const net = useNetwork();
  const sectionIds = [
    "overview",
    "setup",
    "organizations",
    "recipients",
    "reserves",
    "signatures",
    "release",
    "security",
    "scope",
    "evidence",
    "api",
  ];
  const fromHash = () =>
    sectionIds.includes(location.hash.slice(1))
      ? location.hash.slice(1)
      : "overview";
  const [selected, setSelected] = useState(fromHash);
  useEffect(() => {
    const update = () => setSelected(fromHash());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const sections = [
    {
      id: "overview",
      title: t("Documentation"),
      content: (
        <>
          <h1>
            {t("A sponsored start.")}
            <br />
            {t("Clearly documented.")}
          </h1>
          <p>
            {t(
              "Cardea creates a Stellar account and a USDC trustline in one recipient-signed transaction. The recipient starts with zero XLM and retains sole signing authority.",
            )}
          </p>
        </>
      ),
    },
    {
      id: "setup",
      title: t("Run your own instance"),
      content: (
        <>
          <h2 id="setup">{t("Run your own instance")}</h2>
          <p>
            {t(
              "The repository contains the API, worker, PostgreSQL state, browser app and tests. Follow the README to configure the operator and dedicated sponsor, channel and fee-payer accounts for this network. Signing keys stay in the private signer configuration, never in the browser.",
            )}
          </p>
          <a href="https://github.com/glckfatih2018-prog/cardea">
            {t("Repository & installation guide ↗")}
          </a>
        </>
      ),
    },
    {
      id: "organizations",
      title: t("For organizations"),
      content: (
        <>
          <h2>{t("For organizations")}</h2>
          <ol>
            <li>
              {t("Sign in at")} <a href="/organization">{t("the workspace")}</a>
              .
            </li>
            <li>
              {t(
                "Create a pool using a configured sponsor and set reserve and daily fee limits.",
              )}
            </li>
            <li>
              {t(
                networkSpecificCopy(
                  net,
                  "Fund the configured sponsor, channel accounts and fee payer with real XLM before opening a pool.",
                  "Fund the configured sponsor, channel accounts and fee payer with test XLM before opening a pool.",
                ),
              )}
            </li>
            <li>
              {t(
                "For a private pool, add allowed addresses and share invitations. For a public pool, select public access. Activate the pool only after checking its limits.",
              )}
            </li>
            <li>
              {t(
                "Select an allowed recipient and share their individual invitation link. Links are bound to that address. Monitor pending and active reserve commitments separately.",
              )}
            </li>
          </ol>
          <p>
            {t(
              "Pause blocks new sponsorship. It does not revoke existing sponsorship or retract a transaction that is already signed or submitted.",
            )}
          </p>
        </>
      ),
    },
    {
      id: "recipients",
      title: t("For recipients"),
      content: (
        <>
          <h2>{t("For recipients")}</h2>
          <p>
            {t(
              networkSpecificCopy(
                net,
                "Open your invitation in a browser with Freighter, choose the Stellar public network (Mainnet), connect your wallet and approve one transaction. No recovery phrase or private key is requested. Wait for the confirmed ledger result; a submitted transaction is not yet a successful one.",
                "Open your invitation in a browser with Freighter, choose Stellar Testnet, connect your wallet and approve one transaction. No recovery phrase or private key is requested. The account must not already exist for this onboarding flow. Wait for the confirmed ledger result; a submitted transaction is not yet a successful one.",
              ),
            )}
          </p>
        </>
      ),
    },
    {
      id: "reserves",
      title: t("What is sponsored?"),
      content: (
        <>
          <h2>{t("What is sponsored?")}</h2>
          <p>
            {t(
              "At a base reserve of 0.5 XLM, a new account uses two reserve units and a USDC trustline uses one: 1.5 XLM total. This is locked in the sponsor’s account, not transferred to the recipient. The fee payer separately pays the fee-bump transaction fee. Reserve and fee parameters are checked against the network.",
            )}
          </p>
        </>
      ),
    },
    {
      id: "signatures",
      title: t("How signatures are checked"),
      content: (
        <>
          <h2>{t("How signatures are checked")}</h2>
          <p>
            {t(
              "The server saves the exact transaction signature payload. A returned wallet signature must verify against that payload and the expected recipient. Modified transaction fields, wrong networks, extra operations and unexpected signatures are rejected before co-signing. The signed envelope itself differs from the original unsigned envelope because it contains the added signature.",
            )}
          </p>
        </>
      ),
    },
    {
      id: "release",
      title: t("Releasing or transferring a reserve"),
      content: (
        <>
          <h2>{t("Releasing or transferring a reserve")}</h2>
          <p>
            {t(
              "The worker checks whether the recipient can support the reserve using their current account state and liabilities. If sufficient, it removes the sponsorship without moving funds. If not, the reserve stays sponsored. Another funded, consenting sponsor configured by the operator can accept a handover without a new recipient signature.",
            )}
          </p>
        </>
      ),
    },
    {
      id: "security",
      title: t("Security boundaries"),
      content: (
        <>
          <h2>{t("Security boundaries")}</h2>
          <p>
            {t(
              networkSpecificCopy(
                net,
                "This is a self-hosted installation on the Stellar public network, not a hosted custody service and not an independently audited product. The operator’s signer has real authority over sponsor accounts holding real XLM, so secret isolation and bounded budgets matter. Public endpoints do not accept arbitrary transactions for signing.",
                "This is a self-hosted testnet release, not a hosted custody service or a mainnet audit. The operator’s signer has real authority over the sponsor account, so secret isolation matters. Public endpoints do not accept arbitrary transactions for signing. PostgreSQL persists request state, limits, channel leases and the submission outbox. Unknown network outcomes are reconciled by hash before resources are released.",
              ),
            )}
          </p>
        </>
      ),
    },
    {
      id: "scope",
      title: t("Scope"),
      content: (
        <>
          <h2>{t("Scope")}</h2>
          <p>
            {t(
              networkSpecificCopy(
                net,
                "Stellar public network, one canonical USDC issuer, allowlisted or public onboarding, reserve monitoring, graduation and handover. No payouts, Soroban, recipient key generation or multitenant service. Budgets bound possible loss; they do not eliminate it.",
                "Stellar classic testnet, one USDC issuer, allowlisted onboarding, reserve monitoring, graduation and handover. No payouts, mainnet, Soroban, recipient key generation or multitenant service. Browser signing support must be verified with the specific wallet version; automated keypair tests do not establish wallet-extension compatibility.",
              ),
            )}
          </p>
        </>
      ),
    },
    {
      id: "evidence",
      title: t("Evidence"),
      content: (
        <>
          <h2>{t("Evidence")}</h2>
          <p>
            {t(
              "A mainnet recipient opened a zero-XLM account with a sponsored USDC trustline. The recipient remains its sole signer.",
            )}
          </p>
          <ul>
            <li>
              <a href="https://horizon.stellar.org/transactions/ca46d4efba204821eb1fc5261feabdfe110ef10ddf85055bd9b2679d2a9463b0">
                {t("Mainnet onboarding transaction ↗")}
              </a>
            </li>
            <li>
              <a href="https://horizon-testnet.stellar.org/transactions/3a3977bc95edcadaf53b755e23908d89d83586b0e16d1594579ad35b03641d14">
                {t("Testnet automatic reserve release ↗")}
              </a>
            </li>
            <li>
              <a href="https://horizon-testnet.stellar.org/transactions/d05137d9aaf27433f67d1fd4cda8b8768a08bd0662cceb3d3052e6a79a2b4285">
                {t("Testnet sponsor handover ↗")}
              </a>
            </li>
            <li>
              <a href="/evidence/instawards-testnet-walkthrough.mp4">
                {t("Isolated testnet demo video ↗")}
              </a>
            </li>
            <li>
              <a href="/evidence/instawards-testnet-20260930.json">
                {t("Testnet demo result (JSON) ↗")}
              </a>
            </li>
            <li>
              <a href="/evidence/operator-walkthrough.mp4">
                {t("Operator walkthrough video ↗")}
              </a>
            </li>
            <li>
              <a href="/evidence/cardea-delivery.pdf">
                {t("Delivery evidence PDF ↗")}
              </a>
            </li>
          </ul>
          <p>
            {t(
              "The isolated testnet demo records pool creation and a 50-address allowlist. One listed recipient opened a zero-XLM USDC-ready account; the API rejected an unlisted address. The recipient used a throwaway test key through the API, not the Freighter extension. The older operator video is a sequence of still captures.",
            )}
          </p>
        </>
      ),
    },
    {
      id: "api",
      title: t("API"),
      content: (
        <>
          <h2>{t("API")}</h2>
          <p>
            {t("Operator routes:")}
            <code>/api/admin/login</code>,<code>/api/admin/dashboard</code>,{" "}
            <code>/api/admin/pools</code>
            {t(
              "and pool-specific allowlist, policy and handover endpoints. Operator writes require the session’s CSRF token and the configured Origin.",
            )}
          </p>
          <p>
            {t("Recipient routes:")}
            <code>/api/onboarding/prepare</code>,
            <code>/api/onboarding/:id/submit</code>,
            <code>/api/onboarding/:id/status</code>
            {t(
              ". The last route requires the request-bound bearer token. Error and pending states never imply confirmed account creation.",
            )}
          </p>
        </>
      ),
    },
  ];
  const index = sections.findIndex((s) => s.id === selected);
  return (
    <main className="docs-layout">
      <aside className="docs-sidebar">
        <p className="eyebrow">{t("Documentation")}</p>
        <nav aria-label={t("Documentation")}>
          {sections.map((section) => (
            <a
              key={section.id}
              href={"#" + section.id}
              aria-current={selected === section.id ? "page" : undefined}
            >
              {section.title}
            </a>
          ))}
        </nav>
      </aside>
      <article className="docs-content" key={selected}>
        {sections[index].content}
        <div className="docs-pagination">
          {index > 0 ? (
            <a href={"#" + sections[index - 1].id}>
              ← {sections[index - 1].title}
            </a>
          ) : (
            <span />
          )}
          {index < sections.length - 1 && (
            <a href={"#" + sections[index + 1].id}>
              {sections[index + 1].title} →
            </a>
          )}
        </div>
      </article>
    </main>
  );
}
function usePoolDirectory(poolId?: string) {
  const [pools, setPools] = useState<PoolListing[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await api(
          "/onboarding/directory" + (poolId ? "/" + poolId : ""),
        );
        if (!cancelled) {
          setPools(poolId ? [result] : result);
          setError("");
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 15000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [poolId]);
  return { pools, error };
}
const availabilityText = {
  open: "Open for applications",
  full: "Pool full",
  reserved: "Places temporarily reserved",
  paused: "Onboarding paused",
  unavailable: "Temporarily unavailable",
};
function PoolOccupancy({ pool }: { pool: PoolListing }) {
  return (
    <div className="pool-occupancy">
      <span className="occupancy-count">
        <strong>{pool.participants}</strong>
        <span> / {pool.participantLimit ?? t("No set limit")}</span>
      </span>
      {pool.participantLimit !== null && (
        <progress
          value={pool.participants}
          max={pool.participantLimit}
          aria-label={t("Participants")}
        />
      )}
      <span className="pool-meta">
        {t("Participants")}
        {pool.pendingParticipants > 0 && (
          <>
            {" "}
            · {pool.pendingParticipants} {t("pending")}
          </>
        )}
      </span>
    </div>
  );
}
function PoolAccess({ pool }: { pool: PoolListing }) {
  return (
    <span className={"badge pool-access " + pool.access}>
      {t(pool.access === "public" ? "Public pool" : "Private pool")}
    </span>
  );
}
function PublicPools() {
  const { pools, error } = usePoolDirectory();
  const [filter, setFilter] = useState<"all" | "public" | "private">("all");
  const [query, setQuery] = useState("");
  const visible = pools
    ?.filter(
      (p) =>
        (filter === "all" || p.access === filter) &&
        (p.name + " " + p.description)
          .toLocaleLowerCase(getLanguage())
          .includes(query.trim().toLocaleLowerCase(getLanguage())),
    )
    .sort(
      (a, b) =>
        Number(b.availability === "open") - Number(a.availability === "open") ||
        Number(b.access === "public") - Number(a.access === "public"),
    );
  return (
    <main className="pool-directory">
      <div className="directory-heading">
        <div>
          <p className="eyebrow">{t("SPONSORSHIP POOLS")}</p>
          <h1>{t("Find your pool.")}</h1>
          <p className="directory-intro">
            {t(
              "Explore public and private pools. Find a place for your free USDC trustline.",
            )}
          </p>
        </div>
        <a className="text-link" href="/app#invitation">
          {t("I have an invitation")} ↗
        </a>
      </div>
      <div className="directory-toolbar">
        <div
          className="pool-filters"
          role="group"
          aria-label={t("Pool access")}
        >
          {(["all", "public", "private"] as const).map((kind) => (
            <button
              key={kind}
              className={filter === kind ? "selected" : ""}
              aria-pressed={filter === kind}
              onClick={() => setFilter(kind)}
            >
              {t(
                kind === "all"
                  ? "All pools"
                  : kind === "public"
                    ? "Public"
                    : "Private",
              )}
              {pools && (
                <span className="filter-count">
                  {
                    pools.filter((p) => kind === "all" || p.access === kind)
                      .length
                  }
                </span>
              )}
            </button>
          ))}
        </div>
        <label className="pool-search">
          <span className="sr-only">{t("Search pools")}</span>
          <input
            type="search"
            placeholder={t("Search pools")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <Notice error={t(error)} />
      {!pools && !error && <p>{t("Loading…")}</p>}
      {visible?.length === 0 && (
        <div className="directory-empty">
          <h2>{t(pools?.length ? "No matching pools" : "No pools yet")}</h2>
          <p>
            {t(
              pools?.length
                ? "Try another search or filter."
                : "Pools will appear here when an organization creates them.",
            )}
          </p>
        </div>
      )}
      <div className="pool-list">
        {visible?.map((p) => (
          <a className="pool-card" key={p.id} href={"/receive/" + p.id}>
            <div className="pool-card-main">
              <PoolAccess pool={p} />
              <h2>{p.name}</h2>
              <p>
                {p.description ||
                  t(
                    p.access === "public"
                      ? "Join without an invitation."
                      : "A personal invitation is required to join.",
                  )}
              </p>
            </div>
            <PoolOccupancy pool={p} />
            <div className="pool-card-end">
              <span className={"pool-status " + p.availability}>
                {t(availabilityText[p.availability])}
              </span>
              <span className="pool-detail-link">
                {t("View pool")} <span aria-hidden="true">↗</span>
              </span>
            </div>
          </a>
        ))}
      </div>
      <p className="directory-note">
        {t(
          "Sponsorship covers the XLM reserve and network fee. Pools do not distribute USDC.",
        )}
      </p>
    </main>
  );
}
function PoolDetail({ poolId }: { poolId: string }) {
  const net = useNetwork();
  const { pools, error } = usePoolDirectory(poolId);
  const pool = pools?.[0];
  return (
    <main className="pool-directory pool-detail">
      <a className="back-link" href="/receive">
        {t("← All pools")}
      </a>
      <Notice error={t(error)} />
      {!pool && !error && <p>{t("Loading…")}</p>}
      {pool && (
        <>
          <div className="directory-heading">
            <div>
              <PoolAccess pool={pool} />
              <h1>{pool.name}</h1>
            </div>
          </div>
          <div className="pool-detail-grid">
            <div className="pool-story">
              <section>
                <h2>{t("About this pool")}</h2>
                <p className="pool-description">
                  {pool.description ||
                    t(
                      networkSpecificCopy(
                        net,
                        "This pool sponsors the reserve and network fee needed to set up a USDC trustline on the Stellar public network.",
                        "This pool sponsors the reserve and network fee needed to set up a USDC trustline on Stellar testnet.",
                      ),
                    )}
                </p>
              </section>
              <section>
                <h2>{t("What is covered?")}</h2>
                <ul className="coverage-list">
                  <li>{t("USDC trustline reserve")}</li>
                  <li>{t("Account reserve, if you need a new account")}</li>
                  <li>{t("Network transaction fee")}</li>
                </ul>
                <p className="muted">
                  {t(
                    "No USDC is distributed. Your wallet and funds remain under your control.",
                  )}
                </p>
              </section>
              <section>
                <h2>{t("Who can join?")}</h2>
                <p>
                  {t(
                    pool.access === "public"
                      ? networkSpecificCopy(
                          net,
                          "No invitation is needed. Connect a Stellar mainnet wallet without a USDC trustline and sign once.",
                          "No invitation is needed. Connect a Stellar testnet wallet without a USDC trustline and sign once.",
                        )
                      : "You need a personal invitation and an approved wallet address from the pool organizer.",
                  )}
                </p>
                <p className="muted">
                  {t(
                    "Each wallet can join this pool once. Availability depends on the remaining places and sponsor funding.",
                  )}
                </p>
              </section>
            </div>
            <aside className="pool-join-panel">
              <h2>{t("Your place in the pool")}</h2>
              <PoolOccupancy pool={pool} />
              <p className={"pool-status " + pool.availability}>
                {t(availabilityText[pool.availability])}
              </p>
              <p className="muted">
                {t(
                  "Completed participants are shown above. Pending applications temporarily reserve a place.",
                )}
              </p>
              {pool.availability === "open" && !error ? (
                pool.access === "public" ? (
                  <a className="button" href={"/receive/" + pool.id + "/join"}>
                    {t("Join this pool →")}
                  </a>
                ) : (
                  <a className="button" href="/app#invitation">
                    {t("Continue with invitation →")}
                  </a>
                )
              ) : (
                <button disabled>
                  {t(
                    error
                      ? "Temporarily unavailable"
                      : availabilityText[pool.availability],
                  )}
                </button>
              )}
              <p className="pool-meta">
                {t(
                  pool.access === "public"
                    ? "Free to join · One wallet signature"
                    : "Invitation only · Free for recipients",
                )}
              </p>
              <div className="pool-network">
                <span className="badge">{t(networkBadge(net))}</span>
                <p className="pool-meta">
                  {t(
                    networkSpecificCopy(
                      net,
                      "Real XLM reserves. Sponsorship covers reserves and fees only.",
                      "Test assets only. No real funds.",
                    ),
                  )}
                </p>
              </div>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
function Entry() {
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  return (
    <main className="entry-page">
      <p className="eyebrow">{t("Choose your path")}</p>
      <h1>
        {t("A place for")}
        <br />
        <em>{t("every beginning.")}</em>
      </h1>
      <div className="entry-grid">
        <section className="panel">
          <p className="eyebrow">{t("For recipients")}</p>
          <h2>{t("Find your pool.")}</h2>
          <p>
            {t(
              "Explore public and private pools. Find a place for your free USDC trustline.",
            )}
          </p>
          <p>
            <a className="button" href="/receive">
              {t("Browse pools →")}
            </a>
          </p>
          <details
            id="invitation"
            open={location.hash === "#invitation" || undefined}
          >
            <summary>{t("I have an invitation")}</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setError("");
                try {
                  const url = new URL(link.trim(), location.origin);
                  if (
                    url.origin !== location.origin ||
                    !/^\/onboard\/[A-Za-z0-9_-]{20,200}$/.test(url.pathname) ||
                    url.search ||
                    url.hash
                  )
                    throw new Error();
                  location.assign(url.pathname);
                } catch {
                  setError(
                    "Enter a valid Cardea invitation link for this site.",
                  );
                }
              }}
            >
              <label>
                {t("Invitation link")}
                <input
                  type="text"
                  required
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  autoComplete="off"
                  placeholder="https://…/onboard/…"
                />
              </label>
              <button>{t("Continue with invitation →")}</button>
            </form>
            <Notice error={t(error)} />
          </details>
        </section>
        <section className="panel">
          <p className="eyebrow">{t("For organizations")}</p>
          <h2>{t("Manage your sponsorship.")}</h2>
          <p>
            {t(
              "Manage pools and recipients in this installation. Organization access is separate from the recipient invitation flow.",
            )}
          </p>
          <a className="button" href="/organization">
            {t("Organization sign in →")}
          </a>
          <p className="muted">
            {t(
              "New organization? Set up your own Cardea instance to manage your own sponsorship.",
            )}
          </p>
          <a href="/docs/#setup">{t("Read the setup guide →")}</a>
        </section>
      </div>
    </main>
  );
}
function App() {
  useSyncExternalStore(subscribe, getLanguage);
  return (
    <>
      <Header />
      {location.pathname.startsWith("/onboard/") ? (
        <Onboard />
      ) : location.pathname === "/receive" ? (
        <PublicPools />
      ) : /^\/receive\/[a-f0-9-]{36}$/.test(location.pathname) ? (
        <PoolDetail poolId={location.pathname.split("/")[2]} />
      ) : /^\/receive\/[a-f0-9-]{36}\/join$/.test(location.pathname) ? (
        <Onboard poolId={location.pathname.split("/")[2]} />
      ) : location.pathname === "/app" ? (
        <Entry />
      ) : location.pathname === "/organization" ? (
        <Dashboard />
      ) : location.pathname.startsWith("/docs") ? (
        <Documentation />
      ) : (
        <Landing />
      )}
      <Footer />
    </>
  );
}
// The network profile is loaded before first render so no component ever
// starts from an assumed network. If it cannot be loaded, wallet actions stay
// disabled until a reload succeeds; the landing page itself still renders.
Promise.all([initializeLanguage(), loadNetworkInfo()]).finally(() =>
  createRoot(document.getElementById("root")!).render(<App />),
);
