# AgentPay Guard — Design

**Entry:** QIE Hackathon 3.0 (2026, Mainnet Edition) · **Track:** AI + Autonomous Agents
**Builder:** Hamdan Hidayat (solo) · **Status:** design stage — contracts are implemented in later, staged commits.

---

## 1. Problem and idea

AI agents are starting to hold wallets and pay for things, but a normal wallet key is
all-or-nothing: whoever holds it can drain everything. AgentPay Guard replaces that with an
**on-chain spending mandate**. The user (the *mandate owner*) decides in advance exactly what
an agent may do — who it may pay, how much, until when — and the chain enforces it. Payments
inside the mandate execute autonomously; anything outside it is **impossible to execute** and
the attempt is recorded on-chain as a refusal. A fresh one-off approval in QIE Wallet remains
possible for out-of-mandate payments, but the agent key alone can never force them through.

## 2. The mandate model

A mandate lives in `AgentVault` and is defined by:

| Field | Meaning |
|---|---|
| `owner` | The user who created and funds the mandate. Only the owner can change or revoke it. |
| `agent` | Dedicated agent address allowed to call `executePayment`. Holds no other rights: it cannot edit the mandate, change the allowlist, or withdraw funds. |
| Payee allowlist | Set of payee addresses the agent may pay. A payee can be registered by raw address or by **`.qie` name** (resolved to its address via QIE ID / the QIE Wallet MCP at registration time; the name string is stored alongside for display). |
| `perTxCapUsd` | Maximum value of a single payment, denominated in **USD**. |
| `dailyCapUsd` | Maximum total value per rolling 24-hour window, denominated in **USD**. |
| `expiresAt` | Timestamp after which the mandate is dead. At exactly the expiry the mandate no longer executes. |
| `status` | `Active` / `Paused` / `Revoked`. Revoking is instant and permanent. |
| Balance | Native QIE funded by the owner (v1). Owners can withdraw unspent funds at any time. QUSDC support is a planned fast-follow behind the same interface. |

USD caps against native-QIE payments are converted at execution time by `OracleCapAdapter`
using the QIE Oracle's QIE/USD feed, so a cap of "$5 per payment" stays $5 even as the QIE
price moves.

## 3. Contracts

### 3.1 `AgentVault`

User-funded escrow holding all mandates.

- `createMandate(agent, perTxCapUsd, dailyCapUsd, expiresAt)` → mandate id (owner = caller).
- `addPayee(mandateId, payee, qieName)` / `removePayee(mandateId, payee)` — owner only.
- `fund(mandateId)` — payable; adds native QIE to the mandate balance.
- `executePayment(mandateId, payee, amountWei, intentId)` — **agent only**. Checks, in order:
  mandate active and unexpired → payee on the allowlist → oracle-converted USD value ≤
  per-tx cap → daily spent + value ≤ daily cap → sufficient balance. On success it pays the
  payee and tells the registry to mark the intent executed; on any failed check it reverts
  after the registry records the refusal with a reason code.
- `pauseMandate` / `revokeMandate` / `withdrawUnspent` — owner only. Withdrawal only ever
  returns funds to the owner.

Safety patterns: checks-effects-interactions, reentrancy guard on payment/withdrawal paths,
no delegatecall, no upgradeability in v1 (a mandate is a small, auditable escrow — keep it
boring).

### 3.2 `PaymentIntentRegistry`

The public audit trail. Every payment the agent considers becomes an intent:

- Fields: intent hash, rationale hash (the agent's plain-language reason, hashed; full text
  shown in the app), mandate id, payee, token, amount, and a status:
  `Proposed → Executed | Refused | Expired`.
- Refusals carry a machine-readable reason code:
  `OVER_TX_CAP`, `OVER_DAILY_CAP`, `PAYEE_NOT_ALLOWED`, `MANDATE_EXPIRED`,
  `MANDATE_REVOKED`, `INSUFFICIENT_BALANCE`, `ORACLE_UNAVAILABLE`.
- Only `AgentVault` and the registered agent recorder may write. Anyone can read — judges,
  users and the metrics page all read the same trail.

Recording refusals is a deliberate feature: "the agent tried to pay the wrong person and the
chain stopped it" is provable, not a log line we could have edited.

### 3.3 `OracleCapAdapter`

Small adapter over the QIE Oracle's Chainlink-style `AggregatorV3Interface` feed
(QIE/USD: `0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17` on mainnet).

- Reads `latestRoundData()`, checks round completeness and staleness, reads `decimals()`
  rather than assuming 8.
- Converts a token amount to USD value for cap checks.
- **Fails closed:** if the feed reverts or is stale, cap checks cannot pass and the payment
  is refused with `ORACLE_UNAVAILABLE`. (The QIE docs warn an un-updated feed reverts; feed
  liveness is tested on testnet before mainnet use.)

## 4. The agent (off-chain)

- **Read layer:** the hosted, read-only **QIE Wallet MCP** (`https://mcp.qie.digital/mcp`) —
  balances, token lists, `.qie` name resolution, transaction status. The MCP never signs;
  neither can the agent's read layer.
- **Understanding:** the agent parses payment requests / invoices and drafts a plain-language
  rationale for each intent.
- **Policy engine (deterministic, no AI judgement in the loop):** before anything is signed,
  code re-verifies payee ∈ allowlist, amount ≤ per-tx cap at the current oracle price, daily
  headroom, mandate unexpired. The LLM proposes; the policy engine and the contract dispose.
- **Key hygiene:** the agent signs only with a dedicated low-balance key whose sole power is
  calling `executePayment` on `AgentVault`. Worst case for a compromised agent key is bounded
  by the caps, the allowlist, the expiry, and the vault's funded balance.

## 5. Demo script (live, mainnet, tiny amounts)

1. **Create the mandate.** Connect QIE Wallet → create a mandate ($5 per-tx cap, $12 daily
   cap, 7-day expiry) with one payee registered by its `.qie` name → fund it with a small
   amount of mainnet QIE.
2. **A payment inside the mandate.** "Pay this invoice" → the agent resolves the `.qie`
   payee via MCP, the policy engine approves, the vault pays. The UI shows the explorer link
   and the on-chain intent record marked `Executed`.
3. **Over-cap refusal.** Ask for a payment above the per-tx cap → refused on-chain with
   reason `OVER_TX_CAP`, visible in the registry.
4. **Unknown-payee refusal.** Ask for a payment to an address that is not on the allowlist →
   refused with `PAYEE_NOT_ALLOWED`. The agent key cannot route around this.
5. **Revoke.** The owner revokes the mandate from QIE Wallet → a further payment attempt
   fails with `MANDATE_REVOKED`. The user is always one signature away from stopping the
   agent completely.

Each beat maps to a judging criterion: ecosystem integration (Wallet, ID, Oracle, MCP),
real-world usefulness (freelancer/merchant micro-payments), product quality (one continuous
live flow), and originality (on-chain refusal proofs as a first-class feature).

## 6. Traction plan (the second 50% of any prize depends on it)

- **Pilot cohort:** a small, named group of freelancers and micro-merchants from the
  builder's Indonesian communities. Each creates their own mandate and routes real
  micro-payments (small recurring service payments) through their agent.
- **Metrics page (public, from day one of the pilot):** distinct external funding wallets,
  mandates created, external payees paid, repeat payees, executed-intent count and volume.
  Founder and agent test wallets are explicitly labeled and **excluded** from every number —
  no washed metrics.
- This maps directly onto the published milestone categories: wallet growth, transaction
  volume, recurring users, merchants, active monthly usage.

## 7. Build stages (staged commits, in order)

1. Design + Hardhat skeleton (this commit).
2. `AgentVault` + `PaymentIntentRegistry` on QIE testnet (1983) with unit tests for the
   cap / allowlist / expiry / refusal paths.
3. `OracleCapAdapter` + agent: MCP read layer, deterministic policy engine.
4. QIE Wallet front end; full demo rehearsed end-to-end on testnet.
5. Security pass (reentrancy/CEI, agent-key isolation, revoke drills), then mainnet deploy +
   explorer verification.
6. Pilot cohort, metrics page, submission pack.
