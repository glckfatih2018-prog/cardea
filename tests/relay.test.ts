import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Vercel's native JavaScript entrypoint is exercised directly.
import relay from "../api/relay.js";
import { fixture } from "./helpers.ts";
import { server } from "../src/server.ts";
test("explicit Vercel rewrite relays nested login with authenticated identity and cookies", async () => {
  const f = await fixture();
  const secret = "test-relay-native-".repeat(3);
  f.config.relaySecret = secret;
  const http = await server(f.app),
    originalFetch = globalThis.fetch;
  const oldSecret = process.env.CARDEA_RELAY_SECRET,
    oldOrigin = process.env.CARDEA_API_ORIGIN;
  process.env.CARDEA_RELAY_SECRET = secret;
  process.env.CARDEA_API_ORIGIN = "https://backend.example";
  let calls = 0;
  globalThis.fetch = async (input: any, init: any) => {
    calls++;
    const url = new URL(input);
    assert.equal(url.origin, "https://backend.example");
    assert.equal(url.pathname, "/api/admin/login");
    const response = await http.inject({
      method: init.method,
      url: url.pathname,
      remoteAddress: "127.0.0.1",
      headers: init.headers,
      payload: init.body,
    });
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers))
      if (value !== undefined)
        for (const v of Array.isArray(value) ? value : [value])
          headers.append(key, String(v));
    return new Response(response.body, {
      status: response.statusCode,
      headers,
    });
  };
  const invoke = async (route: any) => {
    const result: any = { headers: {}, code: 0, body: null };
    const res: any = {
      setHeader: (k: string, v: any) => {
        result.headers[k] = v;
      },
      status: (n: number) => {
        result.code = n;
        return res;
      },
      json: (v: any) => {
        result.body = v;
        return res;
      },
      send: (v: any) => {
        result.body = JSON.parse(v);
        return res;
      },
    };
    await relay(
      {
        method: "POST",
        url: "/api/admin/login?route=admin/login",
        query: { route },
        headers: {
          origin: f.config.origin,
          "x-vercel-forwarded-for": "203.0.113.7",
          "x-cardea-ip": "198.51.100.9",
          "content-type": "application/json",
        },
        body: { password: "test-operator-password-long" },
      },
      res,
    );
    return result;
  };
  try {
    const good = await invoke("admin/login");
    assert.equal(good.code, 200);
    assert.ok(good.body.csrf);
    assert.ok(good.headers["set-cookie"].length);
    assert.equal((await invoke(["admin/login", "health"])).code, 503);
    assert.equal((await invoke("../outside")).code, 503);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldSecret === undefined) delete process.env.CARDEA_RELAY_SECRET;
    else process.env.CARDEA_RELAY_SECRET = oldSecret;
    if (oldOrigin === undefined) delete process.env.CARDEA_API_ORIGIN;
    else process.env.CARDEA_API_ORIGIN = oldOrigin;
    await http.close();
    await f.close();
  }
});
