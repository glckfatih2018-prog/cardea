import { createHmac } from "node:crypto";
import { isIP } from "node:net";
// Only the Vercel-controlled client IP is attested. No caller headers are forwarded wholesale.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  const secret = process.env.CARDEA_RELAY_SECRET;
  const origin = process.env.CARDEA_API_ORIGIN;
  const ip = req.headers["x-vercel-forwarded-for"];
  const route = req.query.route;
  const path =
    typeof route === "string" &&
    /^(?:health|(?:admin|onboarding)\/[a-zA-Z0-9/-]+)$/.test(route)
      ? "/api/" + route
      : "";
  if (
    !secret ||
    secret.length < 32 ||
    !origin ||
    new URL(origin).protocol !== "https:" ||
    typeof ip !== "string" ||
    !isIP(ip) ||
    !/^\/api\/(admin\/|onboarding\/|health(?:\?|$))/.test(path)
  )
    return res.status(503).json({ error: "Gateway unavailable" });
  const time = String(Math.floor(Date.now() / 1000));
  const headers = {
    "x-cardea-ip": ip,
    "x-cardea-time": time,
    "x-cardea-signature": createHmac("sha256", secret)
      .update(JSON.stringify([req.method, path, ip, time]))
      .digest("hex"),
  };
  for (const name of [
    "origin",
    "cookie",
    "authorization",
    "x-csrf-token",
    "content-type",
  ])
    if (typeof req.headers[name] === "string")
      headers[name] = req.headers[name];
  try {
    const body = ["GET", "HEAD"].includes(req.method)
      ? undefined
      : typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body ?? {});
    if (body && Buffer.byteLength(body) > 32000)
      return res.status(413).json({ error: "Request too large" });
    const upstream = await fetch(new URL(path, origin), {
      method: req.method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(25000),
    });
    for (const name of [
      "content-type",
      "retry-after",
      "x-ratelimit-limit",
      "x-ratelimit-remaining",
      "x-ratelimit-reset",
    ])
      if (upstream.headers.has(name))
        res.setHeader(name, upstream.headers.get(name));
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length) res.setHeader("set-cookie", cookies);
    res.status(upstream.status).send(await upstream.text());
  } catch {
    res.status(503).json({
      error:
        "Request could not be completed. Check its status before retrying.",
    });
  }
}
