// Vercel supplies this country header from the request IP. Do not store IPs.
export function languageForCountry(country) {
  const code = typeof country === "string" ? country.toUpperCase() : "";
  if (code === "TR") return "tr";
  if (["DE", "AT", "LI"].includes(code)) return "de";
  if (["FR", "MC"].includes(code)) return "fr";
  if (
    [
      "ES",
      "MX",
      "AR",
      "BO",
      "CL",
      "CO",
      "CR",
      "CU",
      "DO",
      "EC",
      "SV",
      "GT",
      "HN",
      "NI",
      "PA",
      "PY",
      "PE",
      "UY",
      "VE",
      "GQ",
    ].includes(code)
  )
    return "es";
  return "en";
}
export default function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res
    .status(200)
    .json({ language: languageForCountry(req.headers["x-vercel-ip-country"]) });
}
