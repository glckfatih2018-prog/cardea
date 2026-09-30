/**
 * Cardea exit test.
 *
 * The question this answers: once sponsor A has locked 1.5 XLM behind a user's
 * account and USDC trustline, can A ever get it back?
 *
 * Two things are tested, in order:
 *
 *   1. A tries to revoke its own sponsorship while the user still holds no XLM.
 *      Expected to fail: the reserve would land on a user who cannot cover it.
 *
 *   2. A hands the sponsorship to a second sponsor B. If this works without the
 *      user signing, the pool is a revolving fund: a new backer relieves an
 *      older one, and backers can leave without the user doing anything.
 *
 * Transfer shape (three operations inside one sandwich):
 *   BeginSponsoringFutureReserves(sponsoredId = A)  source: B
 *   RevokeSponsorship(user account entry)           source: A
 *   RevokeSponsorship(user USDC trustline entry)    source: A
 *   EndSponsoringFutureReserves()                   source: A
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

async function sponsoring(publicKey) {
  const account = await server.loadAccount(publicKey)
  return account.num_sponsoring
}

const sponsorA = Keypair.random()
const sponsorB = Keypair.random()
const channel = Keypair.random()
const user = Keypair.random()

await Promise.all([
  fund(sponsorA.publicKey()),
  fund(sponsorB.publicKey()),
  fund(channel.publicKey()),
])

// --- setup: A sponsors the user's account and USDC trustline ---------------
{
  const channelAccount = await server.loadAccount(channel.publicKey())
  const inner = new TransactionBuilder(channelAccount, {
    fee: '200',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: user.publicKey(),
        source: sponsorA.publicKey(),
      }),
    )
    .addOperation(
      Operation.createAccount({
        destination: user.publicKey(),
        startingBalance: '0',
        source: sponsorA.publicKey(),
      }),
    )
    .addOperation(Operation.changeTrust({ asset: USDC, source: user.publicKey() }))
    .addOperation(
      Operation.endSponsoringFutureReserves({ source: user.publicKey() }),
    )
    .setTimeout(120)
    .build()
  inner.sign(channel, sponsorA, user)

  const bumped = TransactionBuilder.buildFeeBumpTransaction(
    sponsorA,
    '400',
    inner,
    Networks.TESTNET,
  )
  bumped.sign(sponsorA)
  await server.submitTransaction(bumped)
}

console.log('setup done')
console.log('A num_sponsoring:', await sponsoring(sponsorA.publicKey()))
console.log('B num_sponsoring:', await sponsoring(sponsorB.publicKey()))

// --- test 1: A revokes alone, user cannot cover the reserve ----------------
{
  const account = await server.loadAccount(sponsorA.publicKey())
  const tx = new TransactionBuilder(account, {
    fee: '200',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.revokeAccountSponsorship({ account: user.publicKey() }))
    .setTimeout(120)
    .build()
  tx.sign(sponsorA)

  try {
    await server.submitTransaction(tx)
    console.log('\ntest 1 (A revokes alone): UNEXPECTED SUCCESS')
  } catch (err) {
    console.log('\ntest 1 (A revokes alone):', JSON.stringify(errorCodes(err)))
  }
}

// --- test 2: hand the sponsorship over to B, without the user signing ------
{
  const channelAccount = await server.loadAccount(channel.publicKey())
  const tx = new TransactionBuilder(channelAccount, {
    fee: '200',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: sponsorA.publicKey(),
        source: sponsorB.publicKey(),
      }),
    )
    .addOperation(
      Operation.revokeAccountSponsorship({
        account: user.publicKey(),
        source: sponsorA.publicKey(),
      }),
    )
    .addOperation(
      Operation.revokeTrustlineSponsorship({
        account: user.publicKey(),
        asset: USDC,
        source: sponsorA.publicKey(),
      }),
    )
    .addOperation(
      Operation.endSponsoringFutureReserves({ source: sponsorA.publicKey() }),
    )
    .setTimeout(120)
    .build()

  // Deliberately NOT signed by the user.
  tx.sign(channel, sponsorA, sponsorB)

  try {
    const res = await server.submitTransaction(tx)
    console.log('\ntest 2 (handover A -> B, no user signature): SUCCESS')
    console.log('hash', res.hash)
  } catch (err) {
    console.log(
      '\ntest 2 (handover A -> B, no user signature): FAILED',
      JSON.stringify(errorCodes(err)),
    )
  }
}

const userAfter = await server.loadAccount(user.publicKey())
console.log('\n--- after ---')
console.log('A num_sponsoring:', await sponsoring(sponsorA.publicKey()))
console.log('B num_sponsoring:', await sponsoring(sponsorB.publicKey()))
console.log('user num_sponsored:', userAfter.num_sponsored)
console.log(
  'user still has USDC trustline:',
  userAfter.balances.some(
    (b) => b.asset_code === 'USDC' && b.asset_issuer === USDC.getIssuer(),
  ),
)
console.log(
  'user signers unchanged:',
  userAfter.signers.length === 1 && userAfter.signers[0].key === user.publicKey(),
)
