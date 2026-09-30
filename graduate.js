/**
 * Cardea graduation test.
 *
 * handover.js showed a sponsor cannot walk away while the user holds no XLM.
 * This asks the other question: what happens once the user can carry the
 * reserve themselves?
 *
 * If revoking succeeds at that point, the pool self-heals. Every user who
 * becomes active on the network hands their backer's capital back without
 * anyone donating anything new, and the queue only has to cover the users who
 * never got going.
 */

import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'

const HORIZON = 'https://horizon-testnet.stellar.org'
const FRIENDBOT = 'https://friendbot.stellar.org'
const USDC = new Asset(
  'USDC',
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
)

const server = new Horizon.Server(HORIZON)

async function fund(publicKey) {
  const res = await fetch(`${FRIENDBOT}?addr=${publicKey}`)
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`)
}

function errorCodes(err) {
  const data = err?.response?.data
  return {
    tx: data?.extras?.result_codes?.transaction,
    ops: data?.extras?.result_codes?.operations,
  }
}

function native(account) {
  return account.balances.find((b) => b.asset_type === 'native')?.balance
}

const sponsor = Keypair.random()
const channel = Keypair.random()
const user = Keypair.random()

await Promise.all([fund(sponsor.publicKey()), fund(channel.publicKey())])

// --- setup: sponsor carries the user's account and USDC trustline ----------
{
  const channelAccount = await server.loadAccount(channel.publicKey())
  const inner = new TransactionBuilder(channelAccount, {
    fee: '200',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: user.publicKey(),
        source: sponsor.publicKey(),
      }),
    )
    .addOperation(
      Operation.createAccount({
        destination: user.publicKey(),
        startingBalance: '0',
        source: sponsor.publicKey(),
      }),
    )
    .addOperation(Operation.changeTrust({ asset: USDC, source: user.publicKey() }))
    .addOperation(
      Operation.endSponsoringFutureReserves({ source: user.publicKey() }),
    )
    .setTimeout(120)
    .build()
  inner.sign(channel, sponsor, user)
  const bumped = TransactionBuilder.buildFeeBumpTransaction(
    sponsor,
    '400',
    inner,
    Networks.TESTNET,
  )
  bumped.sign(sponsor)
  await server.submitTransaction(bumped)
}

const sponsorStart = await server.loadAccount(sponsor.publicKey())
console.log('sponsor num_sponsoring:', sponsorStart.num_sponsoring)
console.log('sponsor XLM:', native(sponsorStart))

// --- the user becomes self-sufficient --------------------------------------
// 1.5 XLM covers the two entries the sponsor is currently carrying; send a
// little more so fees are not the reason anything fails.
{
  const channelAccount = await server.loadAccount(channel.publicKey())
  const tx = new TransactionBuilder(channelAccount, {
    fee: '200',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: user.publicKey(),
        asset: Asset.native(),
        amount: '2',
      }),
    )
    .setTimeout(120)
    .build()
  tx.sign(channel)
  await server.submitTransaction(tx)
}

const userFunded = await server.loadAccount(user.publicKey())
console.log('user XLM after graduating:', native(userFunded))

// --- sponsor now walks away, alone -----------------------------------------
{
  const account = await server.loadAccount(sponsor.publicKey())
  const tx = new TransactionBuilder(account, {
    fee: '200',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.revokeTrustlineSponsorship({
        account: user.publicKey(),
        asset: USDC,
      }),
    )
    .addOperation(
      Operation.revokeAccountSponsorship({ account: user.publicKey() }),
    )
    .setTimeout(120)
    .build()
  tx.sign(sponsor)

  try {
    const res = await server.submitTransaction(tx)
    console.log('\nsponsor revokes alone, user now funded: SUCCESS')
    console.log('hash', res.hash)
  } catch (err) {
    console.log(
      '\nsponsor revokes alone, user now funded: FAILED',
      JSON.stringify(errorCodes(err)),
    )
  }
}

const sponsorEnd = await server.loadAccount(sponsor.publicKey())
const userEnd = await server.loadAccount(user.publicKey())
console.log('\n--- after ---')
console.log('sponsor num_sponsoring:', sponsorEnd.num_sponsoring)
console.log('user num_sponsored:', userEnd.num_sponsored)
console.log(
  'user still has USDC trustline:',
  userEnd.balances.some(
    (b) => b.asset_code === 'USDC' && b.asset_issuer === USDC.getIssuer(),
  ),
)
console.log('user XLM:', native(userEnd))
