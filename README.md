# Cardea

**Sponsor someone onto Stellar without sending them XLM.**

**Site:** [cardea-site.vercel.app](https://cardea-site.vercel.app) · **Docs:** [cardea-site.vercel.app/docs](https://cardea-site.vercel.app/docs/)

An employer paying staff in USDC, or anyone who wants to bring a person onto the network,
locks XLM once. The people they cover get working accounts and never hold XLM at all. The
locked XLM is not spent and can be released again.

Cardea is the Roman goddess of the door hinge. Ovid gives her one power: she opens what is
closed, and closes what is open.

## The problem

On Stellar an address existing is not free. The ledger charges reserves in XLM:

| Entry | XLM |
| --- | --- |
| The account itself | 1.0 |
| A USDC trustline | 0.5 |
| **Per person** | **1.5** |

Someone with zero XLM cannot be paid in USDC. A payment to an address that was never
created is rejected outright, and an address that exists but cannot cover the trustline
reserve cannot open one.

For a company paying fifty people, that is fifty accounts that do not exist yet. The way
this is handled today is to send every recipient about 2 XLM, which is gone for good, or to
tell them to buy XLM on an exchange first, which is not a sentence that belongs in a payroll
run.

Stellar has carried the fix at the protocol level since November 2020.
[CAP-33](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0033.md) lets one
account carry another's reserve without gaining any authority over it, and
[CAP-15](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0015.md) lets a
third party pay the fee. Cardea is the tool that puts those to work.

Note that covering someone's fee is not enough on its own. Fees and reserves are separate
charges, and paying the fee does not give an account the reserve a trustline requires.

## Two sides

### The sponsor

An employer paying staff or contractors in USDC, a programme paying out grants or bounties,
an organisation disbursing aid.

They open a pool, fund it, and set who is covered: an uploaded list of addresses, or a rule
with ceilings. They see how much is committed and to whom, and they can stop taking on
anything further at any moment. The pool is an account in their own name.

What they give up is not the money. It is the money being liquid for a while.

### The recipient

Someone who installed a wallet and holds nothing.

They open a link, connect that wallet, sign once, and their account exists with a USDC
trustline attached. No exchange, no XLM purchase, and they never encounter the word
"trustline".

CAP-33 requires both the sponsor and the sponsored account to sign the same transaction, so
a completely passive recipient cannot be onboarded. That single signature is the whole trust
question, so it is worth saying how it is handled: Cardea builds the transaction and hands
over an unsigned envelope, and what comes back is compared byte for byte against what was
sent. Anything that differs is refused before it is signed or submitted. What the recipient
authorises is fixed by construction, not inspected clause by clause afterwards and hoped to
be complete.

## How the XLM comes back

It is never transferred to the recipient. It stays in the sponsor's account as minimum
balance, and is released when the recipient can carry the reserve themselves, when another
sponsor takes the position over, or when the recipient closes the trustline or the account.

Nothing here pays a yield and nothing here is an investment. The only thing a sponsor gets
back is what they put in.

## Scope

**In:** the transaction builder and its validation layer, a channel account pool, sponsor
pool setup with eligibility rules and ceilings, reserve accounting, automatic release of
recipients who become self-sufficient, and the single-signature recipient flow.

**Out:** Soroban. Assets other than USDC. Generating or holding a wallet on anyone's behalf.
Moving anyone's money: Cardea prepares accounts, it does not deliver funds. Public
leaderboards and open donation pools.

## Licence

MIT.
