/**
 * Does XLM arriving from elsewhere need a trustline?
 *
 * XLM is the native asset, so the trustline question should not apply to it at all.
 * The question that does apply is whether the destination account exists. This checks
 * both, so the answer rests on measurement rather than on reading the docs.
 *
 *   1. Payment of native XLM to an address that was never created.
 *   2. CreateAccount to the same address, then read back what it holds.
 *
 * Whatever a bridge does on the far side, its last step on Stellar is one of these two.
 */

import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'

const server = new Horizon.Server('https://horizon-testnet.stellar.org')

async function fund(publicKey) {
  const res = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`)
  if (!res.ok) throw new Error(`friendbot ${res.status}`)
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

await fund(payer.publicKey())

// --- 1. plain XLM payment to an account that does not exist ----------------
{
  const account = await server.loadAccount(payer.publicKey())
  const tx = new TransactionBuilder(account, {
    fee: '200',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: ghost.publicKey(),
        asset: Asset.native(),
        amount: '5',
      }),
    )
    .setTimeout(120)
    .build()
  tx.sign(payer)

  try {
    await server.submitTransaction(tx)
    console.log('1. XLM payment to non-existent account: SUCCESS')
  } catch (err) {
    console.log('1. XLM payment to non-existent account:', JSON.stringify(errorCodes(err)))
  }
}

// --- 2. same address, via CreateAccount ------------------------------------
{
  const account = await server.loadAccount(payer.publicKey())
  const tx = new TransactionBuilder(account, {
    fee: '200',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.createAccount({
        destination: ghost.publicKey(),
        startingBalance: '5',
      }),
    )
    .setTimeout(120)
    .build()
  tx.sign(payer)

  try {
    await server.submitTransaction(tx)
    console.log('2. CreateAccount with 5 XLM: SUCCESS')
  } catch (err) {
    console.log('2. CreateAccount with 5 XLM:', JSON.stringify(errorCodes(err)))
  }
}

const after = await server.loadAccount(ghost.publicKey())
console.log('\n--- the account now ---')
console.log('balances:', JSON.stringify(after.balances))
console.log('trustline count (non-native balances):',
  after.balances.filter((b) => b.asset_type !== 'native').length)

// --- 3. now that it exists, does a plain XLM payment work? -----------------
{
  const account = await server.loadAccount(payer.publicKey())
  const tx = new TransactionBuilder(account, {
    fee: '200',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: ghost.publicKey(),
        asset: Asset.native(),
        amount: '3',
      }),
    )
    .setTimeout(120)
    .build()
  tx.sign(payer)

  try {
    await server.submitTransaction(tx)
    console.log('\n3. XLM payment to the now-existing account: SUCCESS')
  } catch (err) {
    console.log('\n3. XLM payment to the now-existing account:', JSON.stringify(errorCodes(err)))
  }
}

const final = await server.loadAccount(ghost.publicKey())
console.log('final XLM:', final.balances.find((b) => b.asset_type === 'native')?.balance)
