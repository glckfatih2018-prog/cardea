import Fastify from "fastify";
import { relayIdentity } from "./relay-auth.ts";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import serveStatic from "@fastify/static";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { Cardea, Problem } from "./service.ts";
import { digest, token, passwordMatches } from "./config.ts";
import { now } from "./model.ts";
const id = z.string().uuid(),
  publicAddress = z.string().regex(/^G[A-Z2-7]{55}$/),
  amount = z.string().regex(/^\d{1,10}(\.\d{1,7})?$/);
export async function server(app: Cardea) {
  const f = Fastify({ logger: false, bodyLimit: 32000, trustProxy: false });
  const identities = new WeakMap<object, string>();
  // Bound expensive password work across client IPs as well as per IP.
  let passwordChecksInFlight = 0;
  let passwordCheckStarts: number[] = [];
  f.addHook("onRequest", async (req) => {
    if ((req.routeOptions.url ?? req.url).startsWith("/api/")) {
      const identity = relayIdentity(
        req.method,
        req.url,
        req.headers,
        req.ip,
        app.config.relaySecret,
      );
      if (!identity) throw new Problem(403, "Trusted gateway required");
      identities.set(req, identity);
    }
  });
  await f.register(cookie);
  await f.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
  });
  await f.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: (req) => identities.get(req) ?? req.ip,
  });
  f.addHook("onRequest", async (req, reply) => {
    const route = req.routeOptions.url ?? req.url.split("?")[0];
    if (!route.startsWith("/api")) return;
    reply.header("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== app.config.origin
    )
      throw new Problem(403, "Origin not allowed");
    if (route.startsWith("/api/admin/") && route !== "/api/admin/login") {
      const s = await app.store.read();
      const session = s.sessions.find(
        (s) =>
          s.hash === digest(req.cookies.cardea_session ?? "") &&
          s.expires > now(),
      );
      if (!session) throw new Problem(401, "Sign in required");
      if (req.method !== "GET" && req.headers["x-csrf-token"] !== session.csrf)
        throw new Problem(403, "CSRF token required");
    }
  });
  f.setErrorHandler((err, req, reply) => {
    if (err instanceof Problem)
      return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError)
      return reply.code(400).send({ error: "Invalid request fields" });
    if ((err as any).statusCode === 429)
      return reply.code(429).send({ error: "Too many requests; retry later" });
    if ((err as any).statusCode === 413)
      return reply.code(413).send({ error: "Request too large" });
    return reply.code(503).send({
      error: "Request could not be completed. Retry after checking its status.",
    });
  });
  f.get("/api/health", async (req, reply) => {
    const s = await app.store.read();
    const ready =
      now() - s.workerAt < 90 &&
      now() - (s.monitorAt ?? 0) < 90 &&
      !s.haltReason;
    return reply
      .code(ready ? 200 : 503)
      .send({ ready, network: app.networkProfile.name });
  });
  // Public, read-only profile metadata: name, passphrase, Horizon, issuer,
  // explorer, faucet. No keys, balances, limits or operational state.
  f.get("/api/onboarding/network", () => app.network());
  f.post(
    "/api/admin/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { password } = z
        .object({ password: z.string().max(256) })
        .strict()
        .parse(req.body);
      const started = Date.now();
      passwordCheckStarts = passwordCheckStarts.filter((t) => t > started - 60000);
      if (passwordChecksInFlight >= 2 || passwordCheckStarts.length >= 20)
        throw new Problem(429, "Too many login attempts; retry later");
      passwordCheckStarts.push(started);
      passwordChecksInFlight++;
      let matches: boolean;
      try {
        matches = await passwordMatches(password, app.config.operatorHash);
      } finally {
        passwordChecksInFlight--;
      }
      if (!matches) throw new Problem(401, "Invalid credentials");
      const secret = token(),
        csrf = token();
      await app.store.change((s) => {
        s.sessions = s.sessions.filter((x) => x.expires > now()).slice(-20);
        s.sessions.push({ hash: digest(secret), csrf, expires: now() + 28800 });
      });
      reply.setCookie("cardea_session", secret, {
        httpOnly: true,
        secure: app.config.origin.startsWith("https:"),
        sameSite: "strict",
        path: "/",
        maxAge: 28800,
      });
      return { csrf };
    },
  );
  f.get("/api/admin/session", async (req) => {
    const s = await app.store.read();
    return {
      csrf: s.sessions.find(
        (x) =>
          x.hash === digest(req.cookies.cardea_session ?? "") &&
          x.expires > now(),
      )!.csrf,
    };
  });
  f.post("/api/admin/logout", async (req, reply) => {
    await app.store.change((s) => {
      s.sessions = s.sessions.filter(
        (x) => x.hash !== digest(req.cookies.cardea_session ?? ""),
      );
    });
    reply.clearCookie("cardea_session", { path: "/" });
    return { ok: true };
  });
  f.get("/api/admin/dashboard", () => app.dashboard());
  f.post("/api/admin/pools", async (req) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().max(1000).default(""),
        participantLimit: z
          .number()
          .int()
          .min(1)
          .max(100000)
          .nullable()
          .default(50),
        sponsor: publicAddress,
        cap: amount,
        feeCap: amount,
      })
      .strict()
      .parse(req.body);
    return app.createPool(
      b.name,
      b.sponsor,
      b.cap,
      b.feeCap,
      b.description,
      b.participantLimit,
    );
  });
  f.post("/api/admin/pools/:id/profile", async (req) => {
    const p = z.object({ id }).parse(req.params);
    const b = z
      .object({
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().max(1000),
        participantLimit: z.number().int().min(1).max(100000).nullable(),
      })
      .strict()
      .parse(req.body);
    return app.profile(p.id, b.name, b.description, b.participantLimit);
  });
  f.get("/api/onboarding/directory", () => app.directory());
  f.get("/api/onboarding/directory/:id", (req) =>
    app.directory(z.object({ id }).parse(req.params).id),
  );
  f.post("/api/admin/pools/:id/allowlist", async (req) => {
    const p = z.object({ id }).parse(req.params),
      b = z
        .object({
          addresses: z.array(publicAddress).max(500),
          remove: z.boolean().default(false),
        })
        .strict()
        .parse(req.body);
    return app.allowlist(p.id, b.addresses, b.remove);
  });
  f.get("/api/onboarding/pools", async (_req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    return app.publicPools();
  });
  f.post("/api/admin/pools/:id/access", async (req) => {
    const p = z.object({ id }).parse(req.params);
    const b = z
      .object({ access: z.enum(["private", "public"]) })
      .strict()
      .parse(req.body);
    return app.setAccess(p.id, b.access);
  });
  f.post("/api/admin/pools/:id/policy", async (req) => {
    const p = z.object({ id }).parse(req.params),
      b = z.object({ active: z.boolean() }).strict().parse(req.body);
    return app.policy(p.id, b.active);
  });
  f.post("/api/admin/pools/:id/limits", async (req) => {
    const p = z.object({ id }).parse(req.params),
      b = z.object({ cap: amount, feeCap: amount }).strict().parse(req.body);
    return app.limits(p.id, b.cap, b.feeCap);
  });
  f.post("/api/admin/pools/:id/invite", async (req) =>
    app.rotateInvite(z.object({ id }).parse(req.params).id),
  );
  f.post("/api/admin/pools/:id/handover", async (req) => {
    const p = z.object({ id }).parse(req.params),
      b = z
        .object({ recipient: publicAddress, target: publicAddress })
        .strict()
        .parse(req.body);
    return app.maintenance(p.id, b.recipient, b.target);
  });
  f.post(
    "/api/onboarding/prepare",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const b = z
        .union([
          z
            .object({
              invite: z.string().min(30).max(100),
              recipient: publicAddress,
            })
            .strict(),
          z.object({ pool: id, recipient: publicAddress }).strict(),
        ])
        .parse(req.body);
      // Public requests are keyed by the trusted client identity established
      // in onRequest (relay-attested IP, or the socket IP in direct mode).
      // Nothing in the request body can name an identity.
      return "pool" in b
        ? app.prepare("", b.recipient, b.pool, identities.get(req) ?? req.ip)
        : app.prepare(b.invite, b.recipient);
    },
  );
  f.post("/api/onboarding/:id/submit", async (req) => {
    const p = z.object({ id }).parse(req.params),
      b = z
        .object({ token: z.string().max(100), xdr: z.string().max(20000) })
        .strict()
        .parse(req.body);
    return app.submit(p.id, b.token, b.xdr);
  });
  f.get("/api/onboarding/:id/status", async (req) => {
    const p = z.object({ id }).parse(req.params);
    return app.status(
      p.id,
      String(req.headers.authorization ?? "").replace(/^Bearer /, ""),
    );
  });
  const root = resolve("dist");
  if (existsSync(root)) {
    await f.register(serveStatic, { root });
    f.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/"))
        return reply.code(404).send({ error: "Not found" });
      if (req.method !== "GET") return reply.code(405).send();
      if (/^\/(docs|receive|organization)(\/|$)/.test(req.url.split("?")[0]))
        return reply.sendFile("index.html");
      if (req.url === "/app" || req.url.startsWith("/onboard/"))
        return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Not found" });
    });
  }
  return f;
}
