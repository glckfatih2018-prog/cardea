// Offline research experiment: no network requests, persisted keys or funded wallets.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sdkVersion=JSON.parse(readFileSync(new URL('../../../node_modules/@stellar/stellar-sdk/package.json',import.meta.url),'utf8')).version;
import {Account, Asset, Keypair, Networks, Operation, TransactionBuilder} from '@stellar/stellar-sdk';
const sponsor=Keypair.random(), channel=Keypair.random(), recipient=Keypair.random();
const asset=new Asset('USDC','GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
const build=(limit='922337203685.4775807') => new TransactionBuilder(new Account(channel.publicKey(),'1'),{fee:'0',networkPassphrase:Networks.TESTNET})
.addOperation(Operation.beginSponsoringFutureReserves({source:sponsor.publicKey(),sponsoredId:recipient.publicKey()}))
.addOperation(Operation.createAccount({source:sponsor.publicKey(),destination:recipient.publicKey(),startingBalance:'0'}))
.addOperation(Operation.changeTrust({source:recipient.publicKey(),asset,limit}))
.addOperation(Operation.endSponsoringFutureReserves({source:recipient.publicKey()}))
.setTimebounds(0,2000000000).build();
const tx=build(), unsigned=tx.toXdr(), body=tx.signatureBase(), hash=tx.hash();
tx.sign(recipient);
assert.notEqual(tx.toXdr(),unsigned);
assert.deepEqual(tx.signatureBase(),body);assert.deepEqual(tx.hash(),hash);
assert(recipient.verify(hash,tx.signatures[0].signature));
const changed=build('100');assert.notDeepEqual(changed.signatureBase(),body);
assert(!recipient.verify(changed.hash(),tx.signatures[0].signature));
const wrongNetwork=TransactionBuilder.fromXdr(tx.toXdr(),Networks.PUBLIC);
assert(!recipient.verify(wrongNetwork.hash(),tx.signatures[0].signature));
const feeBump=TransactionBuilder.buildFeeBumpTransaction(sponsor,'100',tx,Networks.TESTNET);
assert.equal(feeBump.fee,'500');
console.log(JSON.stringify({checkedAt:new Date().toISOString(),mode:'OFFLINE_ONLY',sdkVersion,runtime:process.version,checks:7,envelopeChangesAfterSigning:true,signaturePayloadUnchanged:true,hashUnchanged:true,recipientSignatureValid:true,changedTrustLimitRejected:true,wrongNetworkRejected:true,innerFee:tx.fee,outerFeeStroops:feeBump.fee,operations:tx.operations.length,note:'SDK construction/signature verification only; not a wallet interaction or ledger acceptance test.'},null,2));
