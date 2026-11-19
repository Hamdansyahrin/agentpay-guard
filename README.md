# AgentPay Guard for Agent ID

An on-chain spending-policy vault for AI agents, gated by SPACE ID **Agent ID**
identity — built for the Binance Agent ID Hackathon (Binance Wallet × BNB Chain).

An Agent ID holder registers their agent identity, sets a spending policy
(per-transaction cap, daily cap, optional recipient allowlist, human-confirm
threshold), and funds a vault. The registered agent can pay **only** within that
policy. Payments above the confirm threshold require the owner's explicit,
single-use, exact-amount approval recorded on-chain first.

AgentPay Guard is a guardrail for your own funds. **It is not an investment
product and promises no returns of any kind.**

## How Agent ID is used

Agent ID contract (BSC mainnet): `0x60b9262456de011f7d15a54cdd8c48baaa8b022f`
(non-transferable ERC-721 by SPACE ID). Holder check: `balanceOf(address) > 0`.

- **Registration gate:** `AgentPayGuard.register()` reverts unless the caller
  holds an Agent ID. No Agent ID → no registration, no badge, no policy.
- **Identity binding:** the registration records the holder's Agent ID balance
  at registration time. Agent ID is non-transferable, so the binding cannot be
  sold or lent after the fact.
- **Badge precondition:** the soulbound *Guarded Agent* badge (ERC-721,
  non-transferable) is minted only inside `register()` — i.e. only to verified
  Agent ID holders, one per holder.
- **Frontend gate:** the dApp checks `balanceOf` before enabling registration.

Agent ID is never used to look up other people's wallets by name; there is no
name-resolution or people-search feature anywhere in this project.

## Contracts

| Contract | What it does |
|----------|--------------|
| `contracts/AgentPayGuard.sol` | Registry + policy + vault. Constructor deploys the badge. No admin, no proxy, no upgrade path, no fees. |
| `contracts/GuardBadge.sol` | Soulbound "Guarded Agent" badge (minimal ERC-721; all transfers revert). Mintable only by the Guard, once per registered holder. |

Full design — policy model, payment flow, owner-permission surface, judging
mapping, holder-acquisition plan, gas numbers, risks: see **DESIGN.md**.

## Build & test (local)

Requires Foundry (`forge`). No other dependencies — the test suite uses a
hand-declared cheatcode interface instead of forge-std.

```sh
forge build --sizes
forge test
```

Local results for v1:

- `AgentPayGuard` runtime 6,452 B · `GuardBadge` runtime 2,116 B
- Deployment (one transaction, badge included), measured on a local anvil
  node: **1,965,339 gas** → 0.00088 BNB covers it at any gas price
  ≤ ~0.44 gwei (BSC has traded well below that in 2025–26; at a conservative
  1 gwei it would cost ~0.00197 BNB and would not fit — deploy in a low-fee
  window or after a small top-up).
- Tests: **14/14 pass** — non-holder cannot register; holder registers and
  receives the badge; badge is soulbound; policy set + access control; BNB and
  ERC-20 payments within policy execute; above per-tx cap reverts; above daily
  cap reverts; non-allowlisted recipient reverts; above-threshold payment
  requires a recorded owner approval, the approval is single-use and
  exact-amount; non-agent cannot pay; deactivated registration cannot pay;
  owner withdraw works, agent cannot withdraw; daily window resets.

## Frontend

`frontend/index.html` — one static file (ethers v6 via CDN). Connects an
injected wallet on BSC (chain 56), checks Agent ID holding, and exposes
register / set policy / allowlist / deposit / approve-payment plus live
registration, policy, badge, and vault status. Set `GUARD_ADDRESS` at the top
of the file after deployment. Carries a clear risk note; makes no return
promises; never asks for a seed phrase or private key.

## Deployment checklist (not yet done)

1. Read-only `balanceOf` sanity check against the real Agent ID contract.
2. Deploy `AgentPayGuard(agentID = 0x60b9262456de011f7d15a54cdd8c48baaa8b022f)`
   from the deploy wallet in a low-fee window (see gas note above).
3. Verify both contracts on BscScan.
4. Fill `GUARD_ADDRESS` in `frontend/index.html`; host the page.
5. Dogfood: register the `juragan.ai` wallet, set a small policy, run one full
   payment cycle.

## Red-line compliance

- No QR-code/pairing login; standard injected-wallet connection only.
- No bypassing user transaction confirmation — every action is a signed wallet
  transaction; owner approvals are explicit on-chain transactions.
- No unauthorized, scheduled, or bundled transfers — approvals are single-use
  and exact-amount; nothing is scheduled or auto-approved.
- Contracts are open-source; the complete owner-permission surface is
  documented in NatSpec and in DESIGN.md §3.1.
- No Binance/BNB brand impersonation in the product name or UI.
- No collection of seed phrases, private keys, or API secrets.
- No promised returns anywhere.
- Agent ID is not packaged as a tool for looking up other people's wallets.
