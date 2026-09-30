import {
  Account,
  Asset,
  StrKey,
  Transaction,
  TransactionBuilder,
  Operation,
} from "@stellar/stellar-sdk";
import { parseNetworkInfo, type NetworkInfo } from "./network.ts";

const TRUST_LIMIT = "922337203685.4775807";

export type PreparedOnboarding = {
  xdr: string;
  expires: number;
  network: string;
};

/**
 * An honest frontend must not ask Freighter to sign an arbitrary XDR supplied
 * by the API. Independently recognize the one sponsored USDC onboarding body
 * the user expects, then compare its complete signature base to a rebuilt
 * transaction. The institution signer separately validates its own policy.
 */
export function validatePreparedOnboarding(
  prepared: PreparedOnboarding,
  recipient: string,
  network: NetworkInfo,
  at = Math.floor(Date.now() / 1000),
): void {
  const profile = parseNetworkInfo(network);
  if (
    !prepared ||
    typeof prepared.xdr !== "string" ||
    prepared.xdr.length > 20000 ||
    prepared.network !== profile.passphrase ||
    !StrKey.isValidEd25519PublicKey(recipient) ||
    !Number.isSafeInteger(prepared.expires) ||
    prepared.expires <= at ||
    prepared.expires > Math.min(at + 180, (Math.floor(at / 86400) + 1) * 86400)
  )
    throw new Error("Unexpected onboarding transaction");

  let tx: ReturnType<typeof TransactionBuilder.fromXdr>;
  try {
    tx = TransactionBuilder.fromXdr(prepared.xdr, profile.passphrase);
  } catch {
    throw new Error("Unexpected onboarding transaction");
  }
  if (
    !(tx instanceof Transaction) ||
    tx.signatures.length !== 0 ||
    tx.fee !== "0" ||
    !StrKey.isValidEd25519PublicKey(tx.source) ||
    tx.source === recipient ||
    !/^\d+$/.test(tx.sequence) ||
    BigInt(tx.sequence) < 1n ||
    tx.timeBounds?.minTime !== "0" ||
    tx.timeBounds.maxTime !== String(prepared.expires)
  )
    throw new Error("Unexpected onboarding transaction");

  const ops = tx.operations as Array<Record<string, any>>;
  if (ops.length !== 3 && ops.length !== 4)
    throw new Error("Unexpected onboarding transaction");
  const [begin, maybeCreate, change, end] =
    ops.length === 4
      ? [ops[0], ops[1], ops[2], ops[3]]
      : [ops[0], null, ops[1], ops[2]];
  const sponsor = begin?.source;
  if (
    begin?.type !== "beginSponsoringFutureReserves" ||
    !StrKey.isValidEd25519PublicKey(sponsor) ||
    sponsor === recipient ||
    sponsor === tx.source ||
    begin.sponsoredId !== recipient ||
    (maybeCreate &&
      (maybeCreate.type !== "createAccount" ||
        maybeCreate.source !== sponsor ||
        maybeCreate.destination !== recipient ||
        maybeCreate.startingBalance !== "0.0000000")) ||
    change?.type !== "changeTrust" ||
    change.source !== recipient ||
    change.limit !== TRUST_LIMIT ||
    !(change.line instanceof Asset) ||
    change.line.getCode() !== "USDC" ||
    change.line.getIssuer() !== profile.issuer ||
    end?.type !== "endSponsoringFutureReserves" ||
    end.source !== recipient
  )
    throw new Error("Unexpected onboarding transaction");

  let expected = new TransactionBuilder(
    new Account(tx.source, (BigInt(tx.sequence) - 1n).toString()),
    { fee: "0", networkPassphrase: profile.passphrase },
  ).addOperation(
    Operation.beginSponsoringFutureReserves({
      source: sponsor,
      sponsoredId: recipient,
    }),
  );
  if (maybeCreate)
    expected = expected.addOperation(
      Operation.createAccount({
        source: sponsor,
        destination: recipient,
        startingBalance: "0",
      }),
    );
  const rebuilt = expected
    .addOperation(
      Operation.changeTrust({
        source: recipient,
        asset: new Asset("USDC", profile.issuer),
        limit: TRUST_LIMIT,
      }),
    )
    .addOperation(Operation.endSponsoringFutureReserves({ source: recipient }))
    .setTimebounds(0, prepared.expires)
    .build();
  const actualBytes = tx.signatureBase();
  const expectedBytes = rebuilt.signatureBase();
  if (
    actualBytes.length !== expectedBytes.length ||
    !actualBytes.every((byte, index) => byte === expectedBytes[index])
  )
    throw new Error("Unexpected onboarding transaction");
}
