# AgentPay Guard for Agent ID — Design

**Project:** AgentPay Guard for Agent ID (port of the AgentPay Guard concept to BNB Chain)
**Hackathon:** Binance Agent ID Hackathon (Binance Wallet × BNB Chain)
**Chain:** BNB Smart Chain mainnet (chain id 56)
**Status:** v1 built and tested locally. Not yet deployed (see "Deployment readiness").

---

## 1. What it is

AgentPay Guard is a **policy-enforcement vault** for AI-agent payments, gated by
SPACE ID's **Agent ID** identity NFT.

An Agent ID holder registers their agent identity in the Guard registry and sets an
on-chain spending policy for it: a per-transaction cap, a daily cap, and an optional
recipient allowlist. The owner deposits funds into the Guard vault. The agent can then
execute payments **only** if every one of these is true:

1. the request comes from the agent address bound to the registration,
2. the amount is within the per-transaction cap,
3. the amount keeps the day's total spend within the daily cap,
4. the recipient passes the allowlist (when the owner has enabled enforcement), and
5. for amounts **above the owner's "confirm threshold"**, the owner has recorded an
   explicit, single-use, exact-amount approval on-chain beforehand.

It is a guardrail product, not an investment product. It holds the owner's own funds
under the owner's own rules and pays them out only under those rules. **It promises no
returns, yields, or profits of any kind, anywhere — contract, UI, or docs.**

### Why this product, for this hackathon

- Registration is **one transaction** and is the core product flow. It is also the
  natural interaction engine for the on-chain-metrics track: every new guarded agent
  is a distinct Agent ID holder address interacting with our contracts.
- The Agent ID integration is load-bearing, not decorative: without an Agent ID you
  cannot register, cannot get the badge, and your agent cannot be policy-bound.
  That is the "Agent ID integration depth" the Innovation track scores.

---

## 2. Agent ID integration points

Agent ID contract (SPACE ID, BSC mainnet):
`0x60b9262456de011f7d15a54cdd8c48baaa8b022f` — a non-transferable ERC-721.
Holder check used throughout: `balanceOf(address) > 0`.

Integration points:

| # | Point | How |
|---|-------|-----|
| 1 | **Holder gate on registration** | `AgentPayGuard.register()` calls `IAgentID(0x60b9…022f).balanceOf(msg.sender)` and reverts unless `> 0`. Non-holders cannot register, full stop. |
| 2 | **Registration bound to the Agent ID holding** | At registration the contract records the holder's Agent ID balance and registration time in the registration record. Agent ID is non-transferable, so the binding cannot be sold or lent away after the fact; the identity that registered is the identity that stays bound. |
| 3 | **Badge mint precondition** | The soulbound "Guarded Agent" badge is minted only inside `register()`, i.e. only to a verified Agent ID holder, once per holder. |
| 4 | **Public holder surface** | `isAgentIDHolder(address)` view exposes the same check for the frontend and for third parties. |
| 5 | **Frontend gate** | The dApp checks `balanceOf` before enabling the register flow and shows a clear "Agent ID required" state to non-holders. |

What we deliberately do **not** do with Agent ID:

- No name→wallet lookup of other people. The product never resolves another person's
  Agent ID name to their wallet, and the UI has no search-by-name feature.
- No use of Agent ID as a login/session mechanism (and no QR/pairing login flows at all).

---

## 3. Contracts

Two contracts, no proxies, no upgradeability. Small bytecode is a hard requirement
(see gas section).

### 3.1 `AgentPayGuard.sol` — registry + policy + vault (the product)

Deployed once. Its constructor deploys the badge (3.2) so wiring is atomic and only
one deployment transaction is needed.

**State**

- `registrations[owner] → Registration`: `{ agent, active, registeredAt,
  agentIdBalance, policy, dayIndex, spentToday, badgeMinted }`.
- `ownerOfAgent[agent] → owner`: reverse binding; an agent address can serve
  exactly one owner (enforced at registration / agent change).
- `allowlist[owner][recipient] → bool`.
- `balances[owner][token] → uint256`: vault ledger. `token == address(0)` means BNB;
  any other address is an ERC-20. The contract's actual holdings back the ledger.
- `approvals[owner][key] → bool`: single-use owner approvals,
  `key = keccak256(abi.encode(recipient, token, amount))`.

**Functions**

| Function | Who | What |
|----------|-----|------|
| `register(address agent)` | Agent ID holder | Creates the registration, binds `agent`, applies default policy (per-tx cap 0, daily cap 0, confirm threshold 0 = every payment needs approval until the owner configures otherwise — fail-closed), mints the badge. One registration per holder. |
| `setPolicy(perTxCap, dailyCap, confirmThreshold, enforceAllowlist)` | owner | Replaces the policy. Emits `PolicyUpdated`. |
| `setAllowlist(recipient, allowed)` | owner | Adds/removes a recipient. Emits `AllowlistUpdated`. |
| `deposit()` payable | owner | Adds BNB to the owner's vault balance. Emits `Deposited`. |
| `depositToken(token, amount)` | owner | Pulls ERC-20 via `transferFrom` into the owner's vault balance. Emits `Deposited`. |
| `approvePayment(recipient, token, amount)` | owner | Records a single-use approval for one exact payment. Emits `PaymentApproved`. |
| `revokeApproval(recipient, token, amount)` | owner | Clears a recorded approval. Emits `ApprovalRevoked`. |
| `executePayment(recipient, token, amount)` | **agent only** | Runs the full policy check (§4), consumes an approval if one was required, debits the vault, transfers funds, updates daily spend. Emits `PaymentExecuted`. |
| `withdraw(token, amount)` | owner | Owner takes their own funds back out, any time, in full or part. Emits `Withdrawn`. (Policy binds the *agent*, never the owner's own access to their own money.) |
| `updateAgent(newAgent)` | owner | Rebinds the agent address. Emits `AgentUpdated`. |
| `deactivate()` / `reactivate()` | owner | Suspends / resumes the registration; a suspended registration cannot execute payments. Emits `RegistrationDeactivated` / `RegistrationReactivated`. |
| views: `getRegistration`, `getPolicy`, `vaultBalance`, `isAgentIDHolder`, `isAllowlisted`, `hasApproval` | anyone | Read surface for the frontend. |

**Owner-permission surface (also in NatSpec in the code).** There is **no contract
admin**: no global owner, no pause switch, no upgrade path, no fee, no sweep function.
A registrant (owner) **can**: set their own policy, manage their own allowlist,
deposit and withdraw **their own** funds, approve/revoke approvals, change their
agent, deactivate their registration. A registrant **cannot**: touch another
registrant's funds, policy, or approvals; execute payments through the agent path
except via their registered agent address and within policy (registering yourself as
your own agent does not bypass your own caps — only `withdraw` moves your money
outside policy, and only to yourself); mint badges outside registration; change the
Agent ID contract address or any other registration's binding.

### 3.2 `GuardBadge.sol` — soulbound "Guarded Agent" badge

Minimal hand-rolled ERC-721 (kept small on purpose; no library dependency).

- Name `Guarded Agent`, symbol `GAGENT`.
- `mint(to)` callable **only** by the Guard contract; one badge per address, ever.
- Soulbound: `transferFrom`, both `safeTransferFrom` overloads, `approve`, and
  `setApprovalForAll` all revert. The badge is a proof-of-registration marker, not an
  asset.
- Emits the standard `Transfer(address(0), to, tokenId)` plus `BadgeMinted(to, tokenId)`.

### 3.3 Interfaces / mocks

- `IAgentID` — the two functions we need (`balanceOf`, plus `ownerOf` declared for
  completeness) against `0x60b9…022f`.
- Test-only mocks (`MockAgentID`, `MockERC20`) live in `test/` and are **not** part of
  the deployment set.

---

## 4. Policy model and payment flow

**Policy** (per registration):

- `perTxCap` — maximum amount of a single payment.
- `dailyCap` — maximum total paid per UTC day (`block.timestamp / 86400` window;
  `spentToday` resets when the window rolls).
- `confirmThreshold` — amounts **strictly above** this need a recorded owner
  approval. `0` means every payment needs approval (the fail-closed default).
- `enforceAllowlist` — when true, recipients must be allowlisted.

Caps are denominated in the paid asset's smallest unit and apply per payment
regardless of asset (BNB and 18-decimal ERC-20s line up; owners setting caps for
low-decimal tokens must account for that — documented in the UI).

**Payment flow (`executePayment`)**:

1. Resolve `owner = ownerOfAgent[msg.sender]`; revert if none or registration
   inactive. → *only the registered agent can initiate.*
2. Check vault balance ≥ amount.
3. Check `amount ≤ perTxCap`.
4. Roll the daily window if needed; check `spentToday + amount ≤ dailyCap`.
5. If `enforceAllowlist`, check `allowlist[owner][recipient]`.
6. If `amount > confirmThreshold`: compute the approval key; require a recorded
   approval; **delete it** (single-use, exact recipient+token+amount — an approval
   cannot be replayed or redirected).
7. Debit ledger, add to `spentToday`, transfer (BNB via `call`, ERC-20 via
   `transfer` with return-value check), emit `PaymentExecuted`.

Owner approval flow (for above-threshold payments): the owner reviews the intended
payment off-chain (in the dApp, which shows recipient/token/amount), calls
`approvePayment(...)` from their own wallet — a normal, user-confirmed transaction —
and only then can the agent execute that one payment. Nothing is scheduled, bundled,
or auto-approved; there is no standing "approve everything" switch.

---

## 5. Events

Every state change emits an event: `Registered`, `PolicyUpdated`,
`AllowlistUpdated`, `Deposited`, `PaymentApproved`, `ApprovalRevoked`,
`PaymentExecuted`, `Withdrawn`, `AgentUpdated`, `RegistrationDeactivated`,
`RegistrationReactivated`, and in the badge `BadgeMinted` + ERC-721 `Transfer`.
This gives the metrics track a clean, indexable interaction trail.

---

## 6. How the judging dimensions are addressed

**Innovation Award**

- *Agent ID integration depth (30%)* — Agent ID is the registration gate, the
  identity binding, and the badge precondition. Remove Agent ID and the product
  cannot onboard anyone. (§2)
- *Practicality / feasibility (25%)* — A real, recurring problem: agent wallets
  today are either custodial or unbounded. An on-chain, owner-set spending policy
  with a human-confirm tier is directly usable by any Agent ID holder running an
  agent, and it is built from simple, auditable primitives (caps + allowlist +
  single-use approvals) rather than novel cryptography.
- *Product completion (25%)* — Full loop implemented and locally tested:
  register → badge → policy → deposit → approve (when needed) → agent payment →
  owner withdraw, with a working frontend for every step.
- *Innovation (20%)* — The combination is the novelty: soulbound agent identity
  (Agent ID) + a soulbound "guarded" attestation (badge) + an on-chain policy
  engine where the *human-confirm tier is itself an on-chain, single-use,
  exact-amount approval object* — not an off-chain promise.

**On-chain metrics track**

- Registration is one cheap transaction and the entry point to the product, so the
  funnel "Agent ID holder → interacts with our contracts" is as short as it can be.
- Every subsequent action (policy set, deposit, approval, payment) is another
  interaction from a distinct Agent ID holder address, deepening the metric beyond
  one-and-done registrations.

---

## 7. Plan to reach ≥30 interacting Agent ID holders

Honest premise: we cannot manufacture holders, and buying/sybiling registrations
would be both against the spirit of the rules and detectable. The plan is
distribution to *existing* Agent ID holders:

1. **The user's own network first.** The user holds `juragan.ai` and is active in
   BNB/agent communities (Agent ID holders cluster around the Agentic Wallet /
   SPACE ID ecosystem). Direct outreach to agent builders there, with a working
   testnet-style demo flow and the mainnet dApp link.
2. **Registration is the pitch.** "One transaction: your agent gets a spending
   policy and a Guarded Agent badge." Low gas on BSC (~a few cents) keeps the ask
   small. The badge gives holders a visible, soulbound collectible reason to
   register even before they fund the vault.
3. **Builder channels.** Post in the hackathon's own channels and BNB Chain /
   SPACE ID community spaces with a short demo (register → set policy → agent pays
   within policy; agent blocked above cap). Target agent-framework users who
   already hold Agent IDs.
4. **No incentives that break rules.** No promised returns, no airdrop promises,
   no payment for registrations. The offer is the product itself plus the badge.
5. **Fallback honesty.** If organic reach stalls below 30, the metrics track and
   Innovation eligibility suffer — this is the project's single biggest external
   risk (see §9), and no contract trick removes it. The mitigation is starting
   outreach the day the dApp is live, not at the deadline.

---

## 8. Deployment gas estimate (BSC)

Measured locally (Foundry build + a real CREATE transaction against a local
anvil node). Deployment is a **single transaction** (the Guard constructor
deploys the badge).

- Guard runtime bytecode: **6,452 B**; badge runtime bytecode: **2,116 B**.
- Measured deployment gas: **1,965,339 gas** (creation + badge creation + init).

Cost scenarios for 1,965,339 gas (break-even gas price ≈ **0.448 gwei**):

| BSC gas price | Cost | vs 0.00088 BNB on hand |
|---------------|------|------------------------|
| 1 gwei (conservative) | 0.001965 BNB | **Does not fit** — short by ~0.00109 BNB |
| 0.4 gwei | 0.000786 BNB | Fits, ~0.00009 BNB spare (tight) |
| 0.2 gwei | 0.000393 BNB | Fits, ~0.00049 BNB spare |
| 0.05 gwei (BSC has traded here in 2025–26) | 0.000098 BNB | Fits comfortably |

Mitigations if the fee market is at the high end on deploy day: (a) wait for a
low-fee window — BSC fees are usually far below 1 gwei; (b) top up the deploy
wallet with a small amount (~0.002 BNB) — a user decision, not assumed here;
(c) further bytecode diet (already applied: hand-rolled badge, no libraries,
optimizer on). Verification on BscScan after deployment is free.

Post-deploy recurring costs are borne by users per transaction and are small
(register ≈ 150–200k gas, policy set ≈ 50k, payment ≈ 60–90k).

---

## 9. Risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **30-holder threshold not reached** | Innovation track ineligible; metrics track weak | §7 plan; start outreach at launch; badge as the low-friction hook |
| **Deploy wallet underfunded at 1 gwei** (0.00088 BNB) | Cannot deploy on a high-fee day | Low-fee window, small top-up (user decision), bytecode diet (§8) |
| Agent ID contract interface differs from assumed ERC-721 `balanceOf` | Registration gate breaks | Interface is the standard ERC-721 one; verify with a read-only `balanceOf` call against mainnet before deploying the Guard |
| Caps are asset-unit denominated | Owner mis-sets caps for a low-decimal token | Documented in UI + NatSpec; caps are owner-chosen and editable |
| Single-use approval UX friction | Owners annoyed by approving each large payment | That friction *is* the product (human confirm tier); threshold is owner-tunable, including "approve everything above X only" |
| Daily window is UTC-day based, not rolling 24h | Spend can straddle midnight (2× daily cap across a boundary in the worst case) | Documented honestly; acceptable for v1, noted as a known limitation |
| Vault holds user funds | Smart-contract risk to depositors | No admin keys, no sweep, owner-only withdraw of own funds, small audited-by-inspection codebase, events for everything; UI carries a risk note |

---

## 10. Red-line compliance (hackathon safety rules)

- No QR-code/pairing login for Agentic Wallet anywhere; the frontend uses a standard
  injected-wallet connection only.
- No bypassing user transaction confirmation: every state-changing action is a
  normal wallet transaction the user signs; owner approvals are explicit on-chain
  transactions.
- No unauthorized, scheduled, or bundled asset transfers: funds move only via
  owner deposits/withdrawals and policy-checked agent payments. Nothing is
  scheduled; approvals are single-use and exact-amount.
- Contracts are open-source; owner permissions are documented in NatSpec and §3.1.
- No Binance/BNB brand impersonation: the product is named "AgentPay Guard";
  no Binance/BNB logos or names in the product name.
- No collection of seed phrases, private keys, or API secrets — the frontend never
  asks for any; it only uses the injected provider.
- No promised returns anywhere (contract, UI, README, this doc).
- Agent ID is never packaged as a tool to look up other people's wallets by name;
  there is no name-resolution or people-search feature.

---

## 11. Deployment readiness (what's missing)

1. Read-only sanity check of `balanceOf` on the real Agent ID contract from the
   deploy wallet context.
2. Deploy `AgentPayGuard` (constructor takes the Agent ID contract address) from
   the Agentic Wallet (holds ~0.00088 BNB) in a low-fee window, or after a small
   top-up.
3. Verify both contracts on BscScan (Guard + the badge it deployed).
4. Fill the deployed addresses into `frontend/index.html` placeholders.
5. Host the static frontend (any static host) and confirm the live dApp reads
   `chainId 56`.
6. Register `juragan.ai`'s wallet as the first guarded agent (dogfooding) and run
   one full policy-payment cycle on mainnet with a tiny amount.
