# AgentPay Guard

**An autonomous wallet with on-chain spending mandates for AI agents.**

Built by **Hamdan Hidayat** as a solo entry for **QIE Hackathon 3.0** (2026, Mainnet
Edition), track **AI + Autonomous Agents**. 🚧 Work in progress — this repository is being
built in public, in stages, during the hackathon window (submission deadline 30 Nov 2026,
23:59 CET).

## The idea

Give an AI agent a wallet and it can pay anyone, anything, until the money is gone.
AgentPay Guard gives the agent a **mandate** instead:

- a **payee allowlist** (addresses or human-readable `.qie` names),
- **per-transaction and daily spending caps denominated in USD** (converted live via the
  QIE Oracle),
- an **expiry**, and **instant revoke** by the owner.

Payments inside the mandate execute autonomously from a user-funded vault. Anything outside
it **cannot execute** — and the blocked attempt is recorded on-chain with a reason code, so
"the chain stopped the agent" is provable. Every payment intent, execution, and refusal sits
in a public registry: a full audit trail for agent spending.

## How it fits together

- **`AgentVault`** — user-funded escrow holding the mandates; the only contract that moves
  money, and only inside a mandate's rules.
- **`PaymentIntentRegistry`** — on-chain log of intents and their outcomes
  (executed / refused + why).
- **`OracleCapAdapter`** — reads the QIE Oracle QIE/USD feed and converts USD caps to token
  amounts; fails closed if the feed is stale.
- **The agent** reads chain state through the read-only **QIE Wallet MCP**, drafts payment
  intents with a plain-language rationale, and a deterministic policy engine re-checks every
  field before signing. Its dedicated key can only call `executePayment` — never edit a
  mandate or withdraw.
- **Front end** connects with **QIE Wallet**.

Full design: [DESIGN.md](DESIGN.md).

## Networks

| | Chain ID | RPC | Explorer |
|---|---|---|---|
| QIE Testnet | 1983 | https://rpc1testnet.qie.digital/ | https://testnet.qie.digital/ |
| QIE Mainnet | 1990 | https://rpc1mainnet.qie.digital/ | https://mainnet.qie.digital/ |

Development happens on testnet first (free faucet tokens at https://www.qie.digital/faucet —
note: the official faucet is testnet-only and will never ask for a seed phrase, private key,
or any mainnet funds). Mainnet deployment follows once the design is proven on testnet.

## Getting started

```bash
npm install
npx hardhat compile
```

Set `QIE_DEPLOYER_KEY` in your environment for deploys (never commit a key; `.env` and
`*.secret` files are gitignored).

## Status

- [x] Design + project skeleton
- [ ] `AgentVault` + `PaymentIntentRegistry` (testnet, with tests)
- [ ] Oracle adapter + agent (MCP read layer, policy engine)
- [ ] Front end + end-to-end testnet demo
- [ ] Mainnet deploy + verification
- [ ] Pilot users + submission

## Originality note

AgentPay Guard is an original project written for this hackathon. Official QIE SDKs and
standard open-source libraries are used as attributed dependencies; all application code in
this repository is new.
