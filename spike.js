/**
 * Esik feasibility spike.
 *
 * Proves on Stellar testnet that a brand-new account holding zero XLM can be
 * created and given a USDC trustline in a single transaction, with every
 * reserve paid by a sponsor and every fee paid by a fee-bump, while the user
 * keeps sole signing authority over the account.
 *
 * Flow:
 *   fee-bump (feeSource = sponsor)
 *     inner tx (source = channel account, so the sponsor's sequence stays free)
 *       1. BeginSponsoringFutureReserves(sponsoredId = user)   source: sponsor
 *       2. CreateAccount(destination = user, startingBalance 0) source: sponsor
 *       3. ChangeTrust(USDC)                                    source: user
 *       4. EndSponsoringFutureReserves()                        source: user
 *     signatures: channel + sponsor + user
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

async function accountOrNull(publicKey) {
  try {
    return await server.loadAccount(publicKey)
  } catch (err) {
    if (err?.response?.status === 404) return null
    throw err
  }
}

function xlmBalance(account) {
  return account.balances.find((b) => b.asset_type === 'native')?.balance
}

function hasTrustline(account, asset) {
  return account.balances.some(
    (b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  )
}

const sponsor = Keypair.random()
const channel = Keypair.random()
const user = Keypair.random()

console.log('sponsor', sponsor.publicKey())
console.log('channel', channel.publicKey())
console.log('user   ', user.publicKey())

console.log('\nfunding sponsor and channel via friendbot')
await Promise.all([fund(sponsor.publicKey()), fund(channel.publicKey())])

const before = await accountOrNull(user.publicKey())
console.log('user account exists before:', before !== null)
if (before !== null) throw new Error('user account should not exist yet')

const sponsorBefore = await server.loadAccount(sponsor.publicKey())
console.log('sponsor XLM before:', xlmBalance(sponsorBefore))

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
  .addOperation(
    Operation.changeTrust({ asset: USDC, source: user.publicKey() }),
  )
  .addOperation(
    Operation.endSponsoringFutureReserves({ source: user.publicKey() }),
  )
  .setTimeout(120)
  .build()

inner.sign(channel, sponsor, user)

const feeBump = TransactionBuilder.buildFeeBumpTransaction(
  sponsor,
  '400',
  inner,
  Networks.TESTNET,
)
feeBump.sign(sponsor)

console.log('\nsubmitting')
let result
try {
  result = await server.submitTransaction(feeBump)
} catch (err) {
  console.error('submit failed:', JSON.stringify(err?.response?.data ?? err, null, 2))
  process.exit(1)
}

console.log('hash', result.hash)
console.log('ledger', result.ledger)

const after = await server.loadAccount(user.publicKey())
const sponsorAfter = await server.loadAccount(sponsor.publicKey())

const userSigners = after.signers
const userIsSoleSigner =
  userSigners.length === 1 &&
  userSigners[0].key === user.publicKey() &&
  userSigners[0].weight > 0

console.log('\n--- result ---')
console.log('user account exists      :', true)
console.log('user XLM balance         :', xlmBalance(after))
console.log('user has USDC trustline  :', hasTrustline(after, USDC))
console.log('user is sole signer      :', userIsSoleSigner)
console.log('sponsor XLM after        :', xlmBalance(sponsorAfter))
console.log(
  'sponsor XLM delta        :',
  (Number(xlmBalance(sponsorAfter)) - Number(xlmBalance(sponsorBefore))).toFixed(7),
)
console.log(
  'num_sponsoring (sponsor) :',
  sponsorAfter.num_sponsoring ?? '(not exposed by horizon)',
)
console.log(
  'num_sponsored (user)     :',
  after.num_sponsored ?? '(not exposed by horizon)',
)
console.log(
  '\nexplorer:',
  `https://stellar.expert/explorer/testnet/tx/${result.hash}`,
)
