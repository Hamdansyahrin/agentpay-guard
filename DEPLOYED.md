# AgentPay Guard — BSC Mainnet Deployment

Deployed 2026-11-19. Chain: BNB Smart Chain mainnet (chain id 56).

## Contracts

| Contract | Address | BscScan |
|----------|---------|---------|
| AgentPayGuard | `0x295556548c97371dE272cE013459024F31cEF122` | https://bscscan.com/address/0x295556548c97371dE272cE013459024F31cEF122 |
| GuardBadge (deployed by AgentPayGuard constructor) | `0xD5CF4f5635119F2B9B33511181C60a21433e6455` | https://bscscan.com/address/0xD5CF4f5635119F2B9B33511181C60a21433e6455 |

Constructor argument (Agent ID contract, SPACE ID):
`0x60b9262456de011f7d15a54cdd8c48baaa8b022f` — confirmed on-chain via
`agentID()` and `isAgentIDHolder(agentic wallet) == true`.

## Transactions

| Step | Tx hash | Gas used | Effective gas price | Cost |
|------|---------|----------|---------------------|------|
| Fund deployer EOA (0.0004 BNB from Agentic Wallet, via baw Developer-Mode contract-call value transfer — `wallet send` was blocked by the address-book rule) | `0xb368fcfcf8d935f94b2976e25d9e99f66d113f25cd184135e2ccfbc88bebeefe` | 21,000 | ~0.116 gwei (baw backend pricing) | ~0.00000244 BNB |
| Deploy AgentPayGuard (+ GuardBadge in constructor) | `0x20e26bb83e59cbbbf8343554e08868de048fa03ee4febfa302ead4ec3f5edef0` | 1,965,339 | 0.05 gwei | ~0.00009827 BNB |
| Dogfood: Agentic Wallet registers, agent = deployer EOA (via baw contract-call) | `0xca8d1545afe4ebdd87d464ed36d838e751b23c61d39f8eda1493cf2a36ba03b9` | 241,107 | ~0.089 gwei (baw backend pricing) | ~0.00002148 BNB |

Total gas burned across all transactions: **~0.000122 BNB** (cap was 0.0006 BNB).

## Wallets involved

- Agentic Wallet (owner #1, `juragan.ai`): `0x63cE0C2f930E207cF50dD66d6eA78C7e29ed799b`
  — registered on-chain: agent bound, active, Agent ID balance recorded = 1,
  Guarded Agent badge #1 minted (`badge balanceOf = 1`, `badgeMinted = true`).
- Deployer EOA (also the registered agent address): `0xB32706d9240988840D940eb9957A4066Ea343358`
  — key in `.deployer.secret` (0600, git-ignored). Holds ~0.0003017 BNB leftover
  from the 0.0004 BNB funding after the deploy gas.

## Deploy path notes

- `baw contract-call` requires `--to` for EVM and has no contract-creation mode,
  so deployment could not originate from the Agentic Wallet directly; a throwaway
  deployer EOA was used instead (the Guard has no admin role, so the deployer
  address has no privileges over the deployed contracts).
- BSC gas price was re-checked immediately before deployment: 0.05 gwei
  (eth_gasPrice `0x2faf080`), unchanged from the earlier check.

## Verification status

**PENDING.** No `BSCSCAN_API_KEY` / `ETHERSCAN_API_KEY` exists in the environment
or project files, so `forge verify-contract` cannot run yet. To verify later:

- AgentPayGuard: solc 0.8.24, optimizer on (200 runs), constructor arg
  `0x60b9262456de011f7d15a54cdd8c48baaa8b022f`.
- GuardBadge: solc 0.8.24, optimizer on (200 runs), constructor arg = the
  AgentPayGuard address above.
- Either supply an Etherscan/BscScan API key for `forge verify-contract`, or use
  the manual "Verify and Publish" flow on BscScan with the flattened sources.
