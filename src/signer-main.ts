import { loadConfig, networkOf } from "./config.ts";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { signerServer } from "./signer-server.ts";
// The signer is the only process allowed to hold private keys. Its config is
// validated in the "signer" role, so an API/worker file (keys: [] plus a
// signerSocket) cannot be started here and vice versa.
const config = loadConfig("signer");
if (!config.keys.length || config.signerSocket)
  throw new Error("Signer requires private local keys");
const socket = process.env.CARDEA_SIGNER_SOCKET,
  journal = process.env.CARDEA_SIGNER_JOURNAL;
if (!socket || !journal) throw new Error("Signer socket and journal required");
if (existsSync(socket)) unlinkSync(socket);
const server = signerServer(config, journal);
server.requestTimeout = 5000;
server.headersTimeout = 5000;
server.listen(socket, () => chmodSync(socket, 0o660));
console.log(`Cardea ${networkOf(config).name} signer listening`);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
