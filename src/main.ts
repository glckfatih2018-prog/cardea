import { loadConfig, networkOf } from "./config.ts";
import { Store } from "./db.ts";
import { Cardea } from "./service.ts";
import { HorizonChain } from "./stellar.ts";
import { server } from "./server.ts";
const config = loadConfig("service"),
  profile = networkOf(config),
  store = new Store(config.databaseUrl, config.namespace, profile.passphrase);
await store.init();
const app = new Cardea(store, new HorizonChain(profile), config);
const http = await server(app);
await http.listen({ host: process.env.HOST ?? "127.0.0.1", port: config.port });
console.log(`Cardea ${profile.name}: ${config.origin}`);
process.on("SIGTERM", async () => {
  await http.close();
  await store.close();
  process.exit(0);
});
