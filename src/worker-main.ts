import { loadConfig, networkOf } from "./config.ts";
import { Store } from "./db.ts";
import { Cardea } from "./service.ts";
import { HorizonChain } from "./stellar.ts";
const config = loadConfig("service"),
  profile = networkOf(config),
  store = new Store(config.databaseUrl, config.namespace, profile.passphrase);
await store.init();
const app = new Cardea(store, new HorizonChain(profile), config);
let stop = false;
process.on("SIGTERM", () => {
  stop = true;
});
console.log(`Cardea ${profile.name} worker started`);
while (!stop) {
  try {
    await app.tick();
  } catch {
    console.error("Worker cycle failed; pending intents preserved.");
  }
  await new Promise((r) => setTimeout(r, 5000));
}
await store.close();
