import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
export function relayIdentity(
  method: string,
  path: string,
  headers: Record<string, string | string[] | undefined>,
  socketIP: string,
  secret?: string,
) {
  // Direct/local mode never trusts caller-supplied forwarding headers.
  if (!secret) return socketIP;
  const ip = headers["x-cardea-ip"],
    time = headers["x-cardea-time"],
    sig = headers["x-cardea-signature"];
  if (
    typeof ip !== "string" ||
    !isIP(ip) ||
    typeof time !== "string" ||
    !/^\d{10}$/.test(time) ||
    Math.abs(Date.now() / 1000 - Number(time)) > 30 ||
    typeof sig !== "string" ||
    !/^[a-f0-9]{64}$/.test(sig)
  )
    return null;
  const expected = createHmac("sha256", secret)
    .update(JSON.stringify([method, path, ip, time]))
    .digest();
  return timingSafeEqual(expected, Buffer.from(sig, "hex")) ? ip : null;
}
