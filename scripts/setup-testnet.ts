import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  Keypair,
  TransactionBuilder,
  Account,
  Operation,
} from "@stellar/stellar-sdk";
import { TestnetChain, NETWORK, hex } from "../src/stellar.ts";
import { passwordHash, token } from "../src/config.ts";
import { resolveNetwork } from "../src/network.ts";
import { recordWallets } from "./wallet-ledger.ts";
// Testnet fixture setup only. It generates throwaway keys and calls Friendbot;
// it must never run beside a mainnet configuration, so refuse before any
// network call if the local config or CARDEA_CONFIG names another network.
for (const path of [".local/config.json", process.env.CARDEA_CONFIG])
  if (path && existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, "utf8"));
    let name = "unknown";
    try {
      name = resolveNetwork(existing.network).name;
    } catch {}
    if (name !== "testnet")
      throw new Error(
        `${path} is not a testnet configuration; setup:testnet refuses to run`,
      );
  }
mkdirSync(".local", { recursive: true, mode: 0o700 });
const file = ".local/setup-keys.json";
if (!existsSync(file)) {
  const roles = [
    "treasury",
    "sponsorA",
    "sponsorB",
    "feePayer",
    ...Array.from({ length: 10 }, (_, i) => "channel" + i),
  ];
  writeFileSync(
    file,
    JSON.stringify(
      Object.fromEntries(roles.map((r) => [r, Keypair.random().secret()])),
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
const secrets = JSON.parse(readFileSync(file, "utf8")) as Record<
  string,
  string
>;
const keys = Object.fromEntries(
  Object.entries(secrets).map(([k, v]) => [k, Keypair.fromSecret(v)]),
);
recordWallets(
  Object.entries(keys).map(([role, key]) => ({
    role,
    publicKey: key.publicKey(),
  })),
  file,
);
const chain = new TestnetChain();
await chain.snapshot();
let treasury = await chain.account(keys.treasury.publicKey());
if (!treasury) {
  console.log("Funding isolated testnet treasury");
  const r = await fetch(
    "https://friendbot.stellar.org?addr=" + keys.treasury.publicKey(),
    { signal: AbortSignal.timeout(30000) },
  );
  if (!r.ok) throw new Error("Friendbot unavailable");
  treasury = await chain.account(keys.treasury.publicKey());
}
if (!treasury) throw new Error("Treasury not funded");
const missing = [];
for (const [role, key] of Object.entries(keys))
  if (role !== "treasury" && !(await chain.account(key.publicKey())))
    missing.push({ role, key });
if (missing.length) {
  let b = new TransactionBuilder(
    new Account(treasury.account_id, treasury.sequence),
    { fee: "1000", networkPassphrase: NETWORK },
  );
  for (const { role, key } of missing)
    b = b.addOperation(
      Operation.createAccount({
        destination: key.publicKey(),
        startingBalance: role.startsWith("sponsor")
          ? "500"
          : role === "feePayer"
            ? "100"
            : "5",
      }),
    );
  const tx = b.setTimeout(180).build();
  tx.sign(keys.treasury);
  const hash = hex(tx.hash());
  try {
    await chain.submit(tx.toXdr());
  } catch {}
  for (let n = 0; n < 12; n++) {
    const r = await chain.result(hash);
    if (r) {
      if (!r.successful) throw new Error("Role funding failed");
      console.log("Role funding confirmed", hash);
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
for (const [role, key] of Object.entries(keys))
  if (!(await chain.account(key.publicKey())))
    throw new Error("Missing role " + role);
if (!existsSync(".local/config.json")) {
  const password = token();
  writeFileSync(".local/operator-password", password, { mode: 0o600 });
  const pgPassword = readFileSync(".local/pg-password", "utf8").trim();
  const config = {
    network: NETWORK,
    databaseUrl:
      process.env.CARDEA_DATABASE_URL ??
      `postgresql://cardea:${pgPassword}@127.0.0.1:55433/postgres`,
    namespace: "cardea",
    origin: "http://localhost:4317",
    port: 4317,
    operatorHash: passwordHash(password),
    keys: Object.entries(secrets)
      .filter(([r]) => r !== "treasury")
      .map(([, s]) => s),
    sponsors: [keys.sponsorA.publicKey(), keys.sponsorB.publicKey()],
    channels: Array.from({ length: 10 }, (_, i) =>
      keys["channel" + i].publicKey(),
    ),
    feePayer: keys.feePayer.publicKey(),
    baseFee: 1000,
    maxDailyAttempts: 100,
    autoGraduate: true,
  };
  writeFileSync(".local/config.json", JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}
console.log(
  "Testnet setup complete. Private configuration and operator password are in .local/.",
);
