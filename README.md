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
- [x] `AgentVault` + `PaymentIntentRegistry` (testnet, with tests)
- [x] Oracle adapter + agent (MCP-style tool server, policy engine, scripted testnet demo)
- [x] QIE Wallet front end (static app in `app/`, full demo rehearsed on testnet)
- [ ] Mainnet deploy + verification
- [ ] Pilot users + submission

## Demo (QIE testnet)

The agent layer lives in [`agent/`](agent/): a small tool library with a
deterministic policy engine, exposed two ways — an **MCP-style tool server**
(JSON-RPC over stdio, `agent/mcp-server.js`) and a **CLI** (`agent/cli.js`).
The tools let an AI agent read its mandate and caps from `AgentVault`,
propose payment intents, and execute them through `PaymentIntentRegistry` —
where out-of-mandate attempts are refused on-chain with a reason code.

Run the scripted demo against the live testnet deployment:

```bash
npm run agent:demo
```

It creates a fresh mandate ($5 per-tx / $12 daily caps), funds it with
0.25 testnet QIE, registers a payee, then walks the two beats that matter:

1. **In-cap payment executes** — propose 0.1 QIE → policy engine approves →
   the vault pays; the intent is marked `Executed` in the registry and the
   payee's balance increases by exactly 0.1 QIE.
2. **Over-cap payment is refused on-chain** — propose 11 QIE ($5.50 at the
   testnet mock price) → the policy engine predicts `OVER_TX_CAP` → the
   vault refuses, the transaction still mines, and the registry records
   `Refused / OVER_TX_CAP` as proof.

Latest recorded run (2026-11-15, mandate #4): in-cap intent #4 executed
(tx `0x883ee36d…`), over-cap intent #5 refused `OVER_TX_CAP`
(tx `0xcc4899c0…`). Full machine-readable record:
[`deployments/testnet.json`](deployments/testnet.json); human-readable
deployment log: [DEPLOYMENTS.md](DEPLOYMENTS.md).

To plug the tools into an MCP client instead:

```json
{ "mcpServers": { "agentpay-guard": { "command": "node", "args": ["agent/mcp-server.js"] } } }
```

The demo signs with the project's dedicated throwaway **testnet** wallet
(one wallet plays owner/agent/recorder so the demo is self-contained; the
contracts enforce the role separation regardless). Mainnet will use a
separate low-balance agent key whose only power is `executePayment`.

## Front end (QIE testnet)

The web app lives in [`app/`](app/) — a static single page with **no build
step and no framework**. Serve the folder with anything static, e.g.:

```bash
python3 -m http.server --directory app 8080
# then open http://localhost:8080/
```

(or just open the hosted copy — see the repository's GitHub Pages site).

What it does:

- **Wallet connect** (QIE Wallet via EIP-6963, or any EIP-1193 wallet) with a
  network guard for QIE Testnet (1983): a wrong network is a clear read-only
  state with a one-click switch. With **no wallet at all** the app still
  renders read-only from the public testnet RPC — mandates, oracle state and
  the intent log are all live chain data.
- **Mandate panel** — your mandates from `AgentVault`: USD caps, rolling-24h
  spend, funded balance, expiry, and the payee allowlist with `.qie` names.
  Owners can create mandates, fund them, add payees (by address, or by a
  `.qie` name resolved the same way the agent layer resolves it), pause /
  resume, and **revoke** — instantly and permanently.
- **Payment flow** — payee + amount → the deterministic policy engine (the
  same checks, in the same order as the vault) shows the expected verdict
  *before* anything is signed. Executing records the intent and shows the
  outcome read back from the registry: `Executed`, or `Refused` with the
  exact reason code, with explorer links for both transactions.
- **Intent log** — every intent in `PaymentIntentRegistry`, newest first,
  executed and refused alike. The refusals, with their reason badges, are
  the product's signature feature: "the chain stopped the agent" is
  provable, not a log line anyone could have edited.

Every chain call the page makes goes through one module,
[`app/agentpay.js`](app/agentpay.js) — and the rehearsal below imports that
same module unchanged, so the demo a judge clicks through is the code path
proven on-chain.

### Front-end rehearsal (Stage 4)

```bash
npm run app:rehearse
```

drives the DESIGN.md §5 beats through `agentpay.js` with the project
testnet wallet: create/fund a mandate (payee registered as `demo.qie`) →
in-mandate payment **Executed** → over-cap attempt **Refused /
OVER_TX_CAP** → unknown-payee attempt **Refused / PAYEE_NOT_ALLOWED** →
revoke → further attempt **Refused / MANDATE_REVOKED**. The policy engine
predicted the chain's verdict on every beat.

Latest recorded run (2026-11-16, mandate #5): executed intent #6
(tx `0x44c31fe9…`), refused intents #7 `OVER_TX_CAP` (tx `0x339ffc2d…`),
#8 `PAYEE_NOT_ALLOWED` (tx `0x8211e2b8…`), #9 `MANDATE_REVOKED`
(tx `0xa14bc3a7…`). A headless render check (no wallet, read-only) also
passed against the live contracts. Full record:
[`deployments/testnet.json`](deployments/testnet.json) under `stage4`;
human-readable log: [DEPLOYMENTS.md](DEPLOYMENTS.md).

### A note on the oracle

`OracleCapAdapter` wraps the QIE Oracle's QIE/USD feed
(`0x3Bc617cF…D17`, AggregatorV3, 8 decimals, "QIE / USDT" — verified live
on mainnet) and **fails closed**: stale, zero/negative, incomplete, or
unreachable rounds make every payment refuse as `ORACLE_UNAVAILABLE`.
That feed exists **only on mainnet** — QIE ships no testnet feed — so on
testnet the real adapter reports unavailable by design (proven live: with
the real adapter wired in, a payment attempt was refused
`ORACLE_UNAVAILABLE` on-chain), while testnet execution demos run on a
mock adapter at $0.50/QIE. The real adapter goes live with the mainnet
deployment.

## Originality note

AgentPay Guard is an original project written for this hackathon. Official QIE SDKs and
standard open-source libraries are used as attributed dependencies; all application code in
this repository is new.
