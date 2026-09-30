import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error The tiny deployment handler is plain JavaScript.
import handler, { languageForCountry } from "../api/locale.js";
const catalog = JSON.parse(
  readFileSync("web/src/locales/catalog.json", "utf8"),
);
test("all five languages cover the same complete message catalog", () => {
  const keys = Object.keys(catalog.en).sort();
  assert.ok(keys.length > 190);
  for (const lang of ["en", "tr", "de", "fr", "es"]) {
    assert.deepEqual(Object.keys(catalog[lang]).sort(), keys);
    assert.ok(
      Object.values(catalog[lang]).every(
        (x) => typeof x === "string" && x.length > 0,
      ),
    );
  }
});
test("IP country mapping and unsupported or missing country fallback", () => {
  for (const [country, lang] of [
    ["TR", "tr"],
    ["DE", "de"],
    ["AT", "de"],
    ["FR", "fr"],
    ["ES", "es"],
    ["MX", "es"],
    ["US", "en"],
    ["JP", "en"],
    ["CN", "en"],
    ["", "en"],
    ["ZZ", "en"],
    ["tr", "tr"],
  ])
    assert.equal(languageForCountry(country), lang);
  assert.equal(languageForCountry(undefined), "en");
  assert.equal(languageForCountry(["TR", "DE"]), "en");
});
test("locale response is private, uncacheable and exposes no IP", () => {
  let payload: unknown;
  let cache = "";
  let code = 0;
  const res = {
    setHeader(k: string, v: string) {
      if (k === "Cache-Control") cache = v;
    },
    status(n: number) {
      code = n;
      return this;
    },
    json(v: unknown) {
      payload = v;
    },
  };
  handler({ headers: { "x-vercel-ip-country": "TR" } }, res);
  assert.equal(code, 200);
  assert.equal(cache, "private, no-store");
  assert.deepEqual(payload, { language: "tr" });
});
test("language resolution has a local function before the external API proxy", () => {
  const config = JSON.parse(readFileSync("vercel.json", "utf8"));
  assert.equal(config.rewrites[0].source, "/api/locale");
  assert.equal(config.rewrites[0].destination, "/api/locale");
  for (const route of ["/organization", "/docs/:path*"])
    assert.ok(config.rewrites.some((r: any) => r.source === route));
});
