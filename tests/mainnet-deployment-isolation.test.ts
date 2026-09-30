import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL(`../deployment/${path}`, import.meta.url), "utf8");

test("mainnet pilot units cannot reuse testnet state, signer, socket or port", () => {
  const api = read("mainnet/cardea-mainnet-api.service");
  const worker = read("mainnet/cardea-mainnet-worker.service");
  const signer = read("mainnet/cardea-mainnet-signer.service");
  const serviceConfig = JSON.parse(read("config.mainnet-service.example.json"));
  const signerConfig = JSON.parse(read("config.mainnet-signer.example.json"));

  for (const unit of [api, worker, signer]) {
    assert.match(unit, /WorkingDirectory=\/opt\/cardea-mainnet\n/);
    assert.doesNotMatch(unit, /WorkingDirectory=\/opt\/cardea\n/);
    assert.doesNotMatch(unit, /Environment=CARDEA_CONFIG=\/etc\/cardea\/config\.json\n/);
  }
  for (const unit of [api, worker]) {
    assert.match(unit, /User=cardea-mainnet\n/);
    assert.match(unit, /SupplementaryGroups=cardea-mainnet-sign\n/);
    assert.match(unit, /Environment=CARDEA_CONFIG=\/etc\/cardea-mainnet\/config\.json\n/);
    assert.match(unit, /Requires=cardea-mainnet-signer\.service\n/);
  }
  assert.match(signer, /User=cardea-mainnet-signer\n/);
  assert.match(signer, /Group=cardea-mainnet-sign\n/);
  assert.match(signer, /Environment=CARDEA_CONFIG=\/etc\/cardea-mainnet-signer\/config\.json\n/);
  assert.match(signer, /Environment=CARDEA_SIGNER_SOCKET=\/run\/cardea-mainnet-signer\/sign\.sock\n/);
  assert.match(signer, /Environment=CARDEA_SIGNER_JOURNAL=\/var\/lib\/cardea-mainnet-signer\/journal\.json\n/);

  assert.equal(serviceConfig.port, 4318);
  assert.match(serviceConfig.databaseUrl, /\/cardea_mainnet$/);
  assert.equal(serviceConfig.signerSocket, "/run/cardea-mainnet-signer/sign.sock");
  assert.deepEqual(serviceConfig.keys, []);
  assert.ok(signerConfig.keys.length > 0);
  assert.equal(signerConfig.signerSocket, undefined);
});
