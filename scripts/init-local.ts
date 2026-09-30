import { mkdirSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
mkdirSync(".local", { recursive: true, mode: 0o700 });
chmodSync(".local", 0o700);
if (!existsSync(".local/pg-password"))
  writeFileSync(".local/pg-password", randomBytes(32).toString("hex"), {
    mode: 0o600,
  });
console.log(
  "Private local directory and database password ready. Start PostgreSQL next.",
);
