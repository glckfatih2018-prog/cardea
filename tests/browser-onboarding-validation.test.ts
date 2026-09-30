import test from "node:test";
import assert from "node:assert/strict";
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { onboarding, TRUST_LIMIT } from "../src/stellar.ts";
import { MAINNET, TESTNET } from "../src/network.ts";
import { validatePreparedOnboarding } from "../web/src/onboarding-validation.ts";
import type { NetworkInfo } from "../web/src/network.ts";

for (const profile of [TESTNET, MAINNET]) {
  test(`browser accepts only the sponsored USDC onboarding template on ${profile.name}`, () => {
    const channel = Keypair.random();
    const sponsor = Keypair.random();
    const recipient = Keypair.random();
    const another = Keypair.random();
    const at = Math.floor(Date.now() / 1000);
    const expires = Math.min(at + 100, (Math.floor(at / 86400) + 1) * 86400);
    const input = {
      channel: channel.publicKey(),
      sponsor: sponsor.publicKey(),
      recipient: recipient.publicKey(),
      sequence: "1",
      expires,
    };
    const info = profile as NetworkInfo;
    const validate = (xdr: string, responseExpiry = expires) =>
      validatePreparedOnboarding(
        { xdr, expires: responseExpiry, network: profile.passphrase },
        recipient.publicKey(),
        info,
        at,
      );
    const make = (
      ops: any[],
      fee = "0",
      memo?: Memo,
    ) => {
      let b = new TransactionBuilder(new Account(input.channel, "1"), {
        fee,
        networkPassphrase: profile.passphrase,
      });
      for (const op of ops) b = b.addOperation(op);
      if (memo) b = b.addMemo(memo);
      return b.setTimebounds(0, expires).build().toXdr();
    };
    for (const trustlineOnly of [false, true]) {
      const canonical = onboarding({ ...input, trustlineOnly }, profile);
      assert.doesNotThrow(() => validate(canonical.toXdr()));
      assert.throws(() => validate(canonical.toXdr(), expires - 1));
      assert.throws(
        () =>
          validatePreparedOnboarding(
            {
              xdr: canonical.toXdr(),
              expires,
              network:
                profile.name === "mainnet"
                  ? TESTNET.passphrase
                  : MAINNET.passphrase,
            },
            recipient.publicKey(),
            info,
            at,
          ),
        /Unexpected onboarding transaction/,
      );

      const base = [
        Operation.beginSponsoringFutureReserves({
          source: input.sponsor,
          sponsoredId: input.recipient,
        }),
        ...(!trustlineOnly
          ? [Operation.createAccount({
              source: input.sponsor,
              destination: input.recipient,
              startingBalance: "0",
            })]
          : []),
        Operation.changeTrust({
          source: input.recipient,
          asset: new Asset("USDC", profile.issuer),
          limit: TRUST_LIMIT,
        }),
        Operation.endSponsoringFutureReserves({ source: input.recipient }),
      ];
      const bad = (index: number, replacement: any) =>
        make(base.map((op, n) => (n === index ? replacement : op)));
      const trustIndex = trustlineOnly ? 1 : 2;
      const wrongIssuer = Operation.changeTrust({
        source: input.recipient,
        asset: new Asset("USDC", another.publicKey()),
        limit: TRUST_LIMIT,
      });
      const wrongSource = Operation.changeTrust({
        source: another.publicKey(),
        asset: new Asset("USDC", profile.issuer),
        limit: TRUST_LIMIT,
      });
      for (const xdr of [
        bad(trustIndex, wrongIssuer),
        bad(trustIndex, wrongSource),
        bad(
          0,
          Operation.beginSponsoringFutureReserves({
            source: input.sponsor,
            sponsoredId: another.publicKey(),
          }),
        ),
        make([
          ...base,
          Operation.payment({
            source: input.recipient,
            destination: another.publicKey(),
            asset: Asset.native(),
            amount: "1",
          }),
        ]),
        make(base, "100"),
        make(base, "0", Memo.text("extra")),
      ])
        assert.throws(() => validate(xdr), /Unexpected onboarding transaction/);

      const signed = TransactionBuilder.fromXdr(canonical.toXdr(), profile.passphrase);
      assert.ok(signed instanceof Transaction);
      signed.sign(recipient);
      assert.throws(() => validate(signed.toXdr()), /Unexpected onboarding transaction/);
      const bump = TransactionBuilder.buildFeeBumpTransaction(
        another,
        "1000",
        signed,
        profile.passphrase,
      );
      assert.throws(() => validate(bump.toXdr()), /Unexpected onboarding transaction/);
    }
  });
}
