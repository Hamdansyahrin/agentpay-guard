// AgentPay Guard — agent tool library (Stage 3).
//
// The tool surface an AI agent uses to work under an on-chain spending
// mandate (DESIGN.md §4):
//   - getMandate      read a mandate, its caps, payees and window spend
//   - policyCheck     deterministic off-chain mirror of the vault's rules —
//                     predicts the verdict before anything is signed
//   - proposePayment  record a payment intent in PaymentIntentRegistry
//   - executePayment  ask AgentVault to execute; the CHAIN is the arbiter —
//                     an out-of-mandate attempt is refused on-chain and the
//                     refusal (with reason code) is read back as proof
//   - getIntent       read an intent and its outcome from the registry
//   - createMandate / fundMandate / addPayee — owner-side setup helpers the
//                     demo uses (in production the owner does this from
//                     QIE Wallet; the agent key never can)
//
// TESTNET ONLY. The library refuses to write on any chain other than QIE
// testnet (1983). The signing key is the project's dedicated throwaway
// testnet wallet, read in-process from ../.qie-testnet-wallet.secret and
// never printed. On this testnet deployment one wallet plays owner, agent
// and recorder (as in the Stage 2 smoke run) so the demo is self-contained;
// the contract-level role separation is unchanged.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const RPC = process.env.QIE_TESTNET_RPC || "https://rpc1testnet.qie.digital/";
const EXPECTED_CHAIN_ID = 1983n;

const VAULT_ABI = [
  "function createMandate(address agent, uint256 perTxCapUsd, uint256 dailyCapUsd, uint64 expiresAt) returns (uint256)",
  "function addPayee(uint256 mandateId, address payee, string qieName)",
  "function fund(uint256 mandateId) payable",
  "function executePayment(uint256 mandateId, address payee, uint256 amountWei, uint256 intentId) returns (bool)",
  "function getMandate(uint256 mandateId) view returns (address owner, address agent, uint256 perTxCapUsd, uint256 dailyCapUsd, uint64 expiresAt, uint8 status, uint256 balance)",
  "function isPayee(uint256 mandateId, address payee) view returns (bool)",
  "function payeeName(uint256 mandateId, address payee) view returns (string)",
  "function getPayees(uint256 mandateId) view returns (address[])",
  "function spentInWindow(uint256 mandateId) view returns (uint256)",
  "function mandateCount() view returns (uint256)",
  "function oracleAdapter() view returns (address)",
];
const REGISTRY_ABI = [
  "function proposeIntent(bytes32 intentHash, bytes32 rationaleHash, uint256 mandateId, address payee, address token, uint256 amount) returns (uint256)",
  "function getIntent(uint256 intentId) view returns (tuple(bytes32 intentHash, bytes32 rationaleHash, uint256 mandateId, address payee, address token, uint256 amount, uint8 status, uint8 refusalReason, address proposedBy, uint64 createdAt))",
  "function intentCount() view returns (uint256)",
  "function refusalReasonCode(uint8 reason) view returns (string)",
];
const ADAPTER_ABI = [
  "function isAvailable() view returns (bool)",
  "function usdValueOf(uint256 amountWei) view returns (uint256)",
];

const MANDATE_STATUS = ["Active", "Paused", "Revoked"];
const INTENT_STATUS = ["Proposed", "Executed", "Refused", "Expired"];

function loadSecret() {
  const raw = fs.readFileSync(path.join(__dirname, "..", ".qie-testnet-wallet.secret"), "utf8");
  let privateKey = null;
  let mnemonic = null;
  for (const line of raw.split("\n")) {
    let m = line.match(/^\s*privateKey\s*:\s*(0x[0-9a-fA-F]{64})\s*$/);
    if (m) privateKey = m[1];
    m = line.match(/^\s*mnemonic\s*:\s*(.+)\s*$/);
    if (m) mnemonic = m[1];
  }
  if (!privateKey) throw new Error("privateKey not found in testnet wallet file");
  return { privateKey, mnemonic };
}

function loadDeployments() {
  const file = path.join(__dirname, "..", "deployments", "testnet.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function connect() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const network = await provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`refusing to run: expected QIE testnet chainId 1983, got ${network.chainId}`);
  }
  const { privateKey, mnemonic } = loadSecret();
  const signer = new ethers.Wallet(privateKey, provider);
  const dep = loadDeployments();
  const vault = new ethers.Contract(dep.contracts.AgentVault, VAULT_ABI, signer);
  const registry = new ethers.Contract(dep.contracts.PaymentIntentRegistry, REGISTRY_ABI, signer);
  return { provider, signer, dep, vault, registry };
}

/// The demo payee: account 1 of the testnet wallet's mnemonic, so demo funds
/// stay inside the throwaway wallet family and remain recoverable.
function demoPayeeAddress() {
  const { mnemonic } = loadSecret();
  if (!mnemonic) throw new Error("mnemonic not found in testnet wallet file");
  return ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/1").address;
}

const usd = (v) => ethers.formatEther(v); // caps/USD values are 18-decimal
const qie = (v) => ethers.formatEther(v);

// --------------------------------------------------------------------- tools

async function getMandate(ctx, { mandateId }) {
  const m = await ctx.vault.getMandate(mandateId);
  const payeeAddrs = await ctx.vault.getPayees(mandateId);
  const payees = [];
  for (const addr of payeeAddrs) {
    payees.push({ address: addr, qieName: await ctx.vault.payeeName(mandateId, addr) });
  }
  const adapterAddr = await ctx.vault.oracleAdapter();
  const adapter = new ethers.Contract(adapterAddr, ADAPTER_ABI, ctx.provider);
  let oracle = { adapter: adapterAddr, available: false, qiePriceUsd: null };
  try {
    oracle.available = await adapter.isAvailable();
    if (oracle.available) oracle.qiePriceUsd = usd(await adapter.usdValueOf(ethers.parseEther("1")));
  } catch {
    oracle.available = false;
  }
  return {
    mandateId: Number(mandateId),
    owner: m.owner,
    agent: m.agent,
    status: MANDATE_STATUS[Number(m.status)],
    perTxCapUsd: usd(m.perTxCapUsd),
    dailyCapUsd: usd(m.dailyCapUsd),
    spentInWindowUsd: usd(await ctx.vault.spentInWindow(mandateId)),
    balanceQie: qie(m.balance),
    expiresAt: Number(m.expiresAt),
    expiresAtIso: new Date(Number(m.expiresAt) * 1000).toISOString(),
    payees,
    oracle,
  };
}

/// Deterministic policy engine (DESIGN.md §4): re-verifies every field
/// off-chain, in the same order AgentVault._evaluate checks on-chain, and
/// predicts the refusal code. It never overrides the chain — executePayment
/// submits anyway when asked, and the registry's recorded outcome is the
/// verdict that counts.
async function policyCheck(ctx, { mandateId, payee, amountQie }) {
  const amountWei = ethers.parseEther(String(amountQie));
  const m = await ctx.vault.getMandate(mandateId);
  const now = (await ctx.provider.getBlock("latest")).timestamp;
  const checks = {};
  const refuse = (code) => ({ ok: false, predictedRefusal: code, checks });

  checks.mandateStatus = MANDATE_STATUS[Number(m.status)];
  if (Number(m.status) === 2) return refuse("MANDATE_REVOKED");
  if (Number(m.status) === 1) return refuse("MANDATE_PAUSED");
  checks.expired = now >= Number(m.expiresAt);
  if (checks.expired) return refuse("MANDATE_EXPIRED");

  checks.payeeAllowed = await ctx.vault.isPayee(mandateId, payee);
  if (!checks.payeeAllowed) return refuse("PAYEE_NOT_ALLOWED");

  const adapter = new ethers.Contract(await ctx.vault.oracleAdapter(), ADAPTER_ABI, ctx.provider);
  let usdValue;
  try {
    checks.oracleAvailable = await adapter.isAvailable();
    if (!checks.oracleAvailable) return refuse("ORACLE_UNAVAILABLE");
    usdValue = await adapter.usdValueOf(amountWei);
  } catch {
    checks.oracleAvailable = false;
    return refuse("ORACLE_UNAVAILABLE");
  }
  checks.usdValue = usd(usdValue);
  checks.perTxCapOk = usdValue <= m.perTxCapUsd;
  if (!checks.perTxCapOk) return refuse("OVER_TX_CAP");
  const spent = await ctx.vault.spentInWindow(mandateId);
  checks.dailyCapOk = spent + usdValue <= m.dailyCapUsd;
  if (!checks.dailyCapOk) return refuse("OVER_DAILY_CAP");
  checks.balanceOk = amountWei <= m.balance;
  if (!checks.balanceOk) return refuse("INSUFFICIENT_BALANCE");
  return { ok: true, predictedRefusal: null, usdValue: usd(usdValue), checks };
}

async function proposePayment(ctx, { mandateId, payee, amountQie, rationale, reference }) {
  const amountWei = ethers.parseEther(String(amountQie));
  const ref = reference || `payment-${Date.now()}`;
  const intentHash = ethers.keccak256(ethers.toUtf8Bytes(`agentpay:${ref}`));
  const rationaleHash = ethers.keccak256(ethers.toUtf8Bytes(rationale || ""));
  const tx = await ctx.registry.proposeIntent(
    intentHash,
    rationaleHash,
    mandateId,
    payee,
    ethers.ZeroAddress,
    amountWei
  );
  const receipt = await tx.wait();
  const intentId = await ctx.registry.intentCount();
  return {
    intentId: Number(intentId),
    txHash: receipt.hash,
    reference: ref,
    rationale: rationale || "",
    amountQie: String(amountQie),
    payee,
  };
}

async function executePayment(ctx, { mandateId, payee, amountQie, intentId }) {
  const policy = await policyCheck(ctx, { mandateId, payee, amountQie });
  const amountWei = ethers.parseEther(String(amountQie));
  const tx = await ctx.vault.executePayment(mandateId, payee, amountWei, intentId);
  const receipt = await tx.wait();
  const intent = await ctx.registry.getIntent(intentId);
  const status = INTENT_STATUS[Number(intent.status)];
  const refusalReasonCode =
    status === "Refused" ? await ctx.registry.refusalReasonCode(intent.refusalReason) : null;
  return {
    intentId: Number(intentId),
    txHash: receipt.hash,
    txStatus: receipt.status === 1 ? "mined" : "failed",
    executed: status === "Executed",
    intentStatus: status,
    refusalReasonCode,
    policyPrediction: policy.ok ? "ok" : policy.predictedRefusal,
    policyMatchedChain: (policy.ok && status === "Executed") || policy.predictedRefusal === refusalReasonCode,
  };
}

async function getIntent(ctx, { intentId }) {
  const i = await ctx.registry.getIntent(intentId);
  return {
    intentId: Number(intentId),
    mandateId: Number(i.mandateId),
    payee: i.payee,
    token: i.token,
    amountQie: qie(i.amount),
    status: INTENT_STATUS[Number(i.status)],
    refusalReasonCode:
      Number(i.status) === 2 ? await ctx.registry.refusalReasonCode(i.refusalReason) : null,
    proposedBy: i.proposedBy,
    createdAt: Number(i.createdAt),
  };
}

// Owner-side setup helpers (demo only — production owners use QIE Wallet).
async function createMandate(ctx, { perTxCapUsd, dailyCapUsd, expiryDays }) {
  const now = (await ctx.provider.getBlock("latest")).timestamp;
  const tx = await ctx.vault.createMandate(
    ctx.signer.address, // the demo wallet is also the agent (see header note)
    ethers.parseEther(String(perTxCapUsd)),
    ethers.parseEther(String(dailyCapUsd)),
    now + Math.floor(expiryDays * 24 * 3600)
  );
  const receipt = await tx.wait();
  return { mandateId: Number(await ctx.vault.mandateCount()), txHash: receipt.hash };
}

async function fundMandate(ctx, { mandateId, amountQie }) {
  const tx = await ctx.vault.fund(mandateId, { value: ethers.parseEther(String(amountQie)) });
  const receipt = await tx.wait();
  return { mandateId: Number(mandateId), fundedQie: String(amountQie), txHash: receipt.hash };
}

async function addPayee(ctx, { mandateId, payee, qieName }) {
  const tx = await ctx.vault.addPayee(mandateId, payee, qieName || "");
  const receipt = await tx.wait();
  return { mandateId: Number(mandateId), payee, qieName: qieName || "", txHash: receipt.hash };
}

// ------------------------------------------------------------- tool registry

const TOOLS = {
  get_mandate: {
    description:
      "Read an AgentPay Guard mandate from AgentVault: owner, agent, status, USD caps, amount already spent in the rolling 24h window, funded balance, payee allowlist (with .qie names), expiry, and the live oracle adapter state.",
    inputSchema: {
      type: "object",
      properties: { mandateId: { type: "integer", minimum: 1 } },
      required: ["mandateId"],
    },
    run: (ctx, args) => getMandate(ctx, args),
  },
  policy_check: {
    description:
      "Deterministic pre-flight check of a hypothetical payment against a mandate (payee allowlist, oracle price, per-tx and daily USD caps, expiry, balance). Predicts the on-chain verdict incl. the refusal code; the chain remains the final arbiter.",
    inputSchema: {
      type: "object",
      properties: {
        mandateId: { type: "integer", minimum: 1 },
        payee: { type: "string" },
        amountQie: { type: "string" },
      },
      required: ["mandateId", "payee", "amountQie"],
    },
    run: (ctx, args) => policyCheck(ctx, args),
  },
  propose_payment: {
    description:
      "Record a payment intent in PaymentIntentRegistry (hash of the payment reference + hash of the plain-language rationale). Must be proposed before it can be executed.",
    inputSchema: {
      type: "object",
      properties: {
        mandateId: { type: "integer", minimum: 1 },
        payee: { type: "string" },
        amountQie: { type: "string" },
        rationale: { type: "string" },
        reference: { type: "string" },
      },
      required: ["mandateId", "payee", "amountQie"],
    },
    run: (ctx, args) => proposePayment(ctx, args),
  },
  execute_payment: {
    description:
      "Execute a previously proposed intent through AgentVault. In-mandate payments pay the payee; out-of-mandate attempts are refused ON-CHAIN and the refusal + reason code is read back from the registry as proof. The result includes the off-chain policy prediction and whether the chain agreed.",
    inputSchema: {
      type: "object",
      properties: {
        mandateId: { type: "integer", minimum: 1 },
        payee: { type: "string" },
        amountQie: { type: "string" },
        intentId: { type: "integer", minimum: 1 },
      },
      required: ["mandateId", "payee", "amountQie", "intentId"],
    },
    run: (ctx, args) => executePayment(ctx, args),
  },
  get_intent: {
    description: "Read one payment intent and its outcome (Proposed/Executed/Refused + reason code/Expired) from PaymentIntentRegistry.",
    inputSchema: {
      type: "object",
      properties: { intentId: { type: "integer", minimum: 1 } },
      required: ["intentId"],
    },
    run: (ctx, args) => getIntent(ctx, args),
  },
  create_mandate: {
    description:
      "OWNER-side setup (demo): create a mandate in AgentVault with USD per-tx and daily caps and an expiry in days. In production the owner does this from QIE Wallet, never via the agent.",
    inputSchema: {
      type: "object",
      properties: {
        perTxCapUsd: { type: "string" },
        dailyCapUsd: { type: "string" },
        expiryDays: { type: "number" },
      },
      required: ["perTxCapUsd", "dailyCapUsd", "expiryDays"],
    },
    run: (ctx, args) => createMandate(ctx, args),
  },
  fund_mandate: {
    description: "OWNER-side setup (demo): fund a mandate with native testnet QIE.",
    inputSchema: {
      type: "object",
      properties: { mandateId: { type: "integer", minimum: 1 }, amountQie: { type: "string" } },
      required: ["mandateId", "amountQie"],
    },
    run: (ctx, args) => fundMandate(ctx, args),
  },
  add_payee: {
    description: "OWNER-side setup (demo): add a payee to a mandate's allowlist, optionally with its .qie name.",
    inputSchema: {
      type: "object",
      properties: {
        mandateId: { type: "integer", minimum: 1 },
        payee: { type: "string" },
        qieName: { type: "string" },
      },
      required: ["mandateId", "payee"],
    },
    run: (ctx, args) => addPayee(ctx, args),
  },
};

module.exports = { connect, demoPayeeAddress, TOOLS };
