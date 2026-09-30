/**
 * Esik control case.
 *
 * Shows the two failures Esik exists to remove, so the sponsored path in
 * spike.js is measured against something rather than asserted:
 *
 *   1. A USDC payment to an account that does not exist fails with op_no_destination.
 *   2. An account that exists but holds no XLM cannot open a USDC trustline
 *      itself: it fails with tx_insufficient_balance, because the trustline
 *      needs another 0.5 XLM of reserve it does not have.
 *
 * Case 2 is the one people miss. A fee-bump alone does not fix it: the fee is
 * paid by someone else, but the reserve requirement still lands on the user.
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

const payer = Keypair.random()
const ghost = Keypair.random()
const broke = Keypair.random()

await fund(payer.publicKey())

// --- case 1: pay USDC to an address that has never been created -------------
{
  const account = await server.loadAccount(payer.publicKey())
  const tx = new TransactionBuilder(account, {
    fee: '200',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: ghost.publicKey(),
        asset: USDC,
        amount: '1',
      }),
    )
    .setTimeout(120)
    .build()
  tx.sign(payer)

  try {
    await server.submitTransaction(tx)
    console.log('case 1: UNEXPECTED SUCCESS')
  } catch (err) {
    console.log('case 1 (USDC to non-existent account):', JSON.stringify(errorCodes(err)))
  }
}

// --- case 2: a zero-XLM account tries to open its own trustline -------------
// Create `broke` with a starting balance that covers the base account reserve
// but leaves nothing for a trustline, then fee-bump its ChangeTrust so fees are
// demonstrably not the blocker.
{
  const account = await server.loadAccount(payer.publicKey())
  const create = new TransactionBuilder(account, {
    fee: '200',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.createAccount({
        destination: broke.publicKey(),
        startingBalance: '1',
      }),
    )
    .setTimeout(120)
    .build()
  create.sign(payer)
  await server.submitTransaction(create)

  const brokeAccount = await server.loadAccount(broke.publicKey())
  console.log(
    'broke account XLM:',
    brokeAccount.balances.find((b) => b.asset_type === 'native')?.balance,
  )

  const inner = new TransactionBuilder(brokeAccount, {
    fee: '200',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(120)
    .build()
  inner.sign(broke)

  const bumped = TransactionBuilder.buildFeeBumpTransaction(
    payer,
    '400',
    inner,
    Networks.TESTNET,
  )
  bumped.sign(payer)

  try {
    await server.submitTransaction(bumped)
    console.log('case 2: UNEXPECTED SUCCESS')
  } catch (err) {
    console.log(
      'case 2 (fee-bumped ChangeTrust, no reserve):',
      JSON.stringify(errorCodes(err)),
    )
  }
}
