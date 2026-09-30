import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
export function recordWallets(
  wallets: { role: string; publicKey: string }[],
  keyFile: string,
) {
  const path = process.env.CARDEA_WALLET_LEDGER;
  if (!path) return;
  const old = readFileSync(path, "utf8");
  const lines = wallets
    .filter((w) => !old.includes(w.publicKey))
    .map(
      (w) =>
        `- Cardea / Stellar Instawards — ${w.role}; **TEST, ödül cüzdanı değil**; Stellar Testnet (network ID cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472); \`${w.publicKey}\`; anahtardan adres doğrulama ${new Date().toISOString()}; yerel anahtar dosyası: \`${resolve(keyFile)}\`.`,
    );
  if (lines.length) appendFileSync(path, "\n" + lines.join("\n") + "\n");
}
