#!/usr/bin/env node
// AgentPay Guard — front-end rehearsal (Stage 4).
//
//   node app/rehearse.js        (or: npm run app:rehearse)
//
// Drives the DESIGN.md §5 demo beats end-to-end on QIE testnet through
// the FRONT END's own chain module (app/agentpay.js) — the exact code
// the web page runs — with the project testnet wallet as signer (via
// the Stage 3 agent library's connect(), which loads the key in-process
// and refuses any chain other than 1983). If a beat cannot pass through
// the UI module, the fix belongs in the module, not here.
//
// Beats (testnet amounts; caps are the design's $5 / $12 at the mock
// adapter's $0.50/QIE):
//   1. create + fund a mandate, register the payee as demo.qie
//   2. in-mandate payment        -> intent Executed, payee +0.1 QIE
//   3. over-cap attempt (11 QIE) -> intent Refused / OVER_TX_CAP
//   4. unknown-payee attempt     -> intent Refused / PAYEE_NOT_ALLOWED
//   5. revoke, then pay again    -> intent Refused / MANDATE_REVOKED
// The module's policy engine must predict the chain's verdict every time.
// Results merge into deployments/testnet.json under stage4.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { createClient } = require("./agentpay");
const agentLib = require("../agent/lib");

const STRANGER = "0x000000000000000000000000000000000000dEaD";

function assert(cond, msg) {
  if (!cond) throw new Error(`rehearsal assertion failed: ${msg}`);
}

async function main() {
  const ctx = await agentLib.connect(); // validates chain 1983, loads signer
  const signer = ctx.signer;
  const provider = signer.provider;
  const client = createClient(ethers);
  const payee = agentLib.demoPayeeAddress();
  const out = { payee, steps: {} };
  console.log(`wallet: ${signer.address}`);
  console.log(`payee (demo.qie): ${payee}`);

  // Beat 1 — create, register payee, fund.
  const created = await client.createMandate(signer, {
    agent: signer.address, // one wallet plays owner+agent on testnet (see agent/lib.js)
    perTxCapUsd: "5",
    dailyCapUsd: "12",
    expiryDays: 7,
  });
  out.steps.createMandate = created;
  const mandateId = created.mandateId;
  console.log(`mandate #${mandateId} created: ${created.txHash}`);

  out.steps.addPayee = await client.addPayee(signer, { mandateId, payee, qieName: "demo.qie" });
  console.log(`payee added as demo.qie: ${out.steps.addPayee.txHash}`);

  out.steps.fundMandate = await client.fundMandate(signer, { mandateId, amountQie: "0.15" });
  console.log(`funded 0.15 QIE: ${out.steps.fundMandate.txHash}`);

  const readBack = await client.getMandate(provider, mandateId);
  out.steps.readMandate = readBack;
  console.log(
    `mandate read via UI module: caps $${readBack.perTxCapUsd}/tx, $${readBack.dailyCapUsd}/day, ` +
      `balance ${readBack.balanceQie} QIE, oracle $${readBack.oracle.qiePriceUsd}/QIE`
  );
  assert(readBack.status === "Active", "mandate not Active");
  assert(readBack.balanceQie === "0.15", `expected balance 0.15, got ${readBack.balanceQie}`);
  assert(
    readBack.payees.length === 1 && readBack.payees[0].qieName === "demo.qie",
    "payee demo.qie not registered"
  );

  // Beat 2 — in-mandate payment executes.
  const payeeBefore = await provider.getBalance(payee);
  const okPay = await client.pay(signer, {
    mandateId,
    payee,
    amountQie: "0.1",
    rationale: "Rehearsal invoice #1 — inside the mandate caps, paying demo.qie for services.",
    reference: "rehearsal-invoice-1",
  });
  out.steps.payInMandate = okPay;
  const payeeAfter = await provider.getBalance(payee);
  console.log(`in-mandate payment: intent #${okPay.intentId} -> ${okPay.intentStatus} (${okPay.executeTxHash})`);
  assert(okPay.executed && okPay.intentStatus === "Executed", "in-mandate payment did not execute");
  assert(payeeAfter - payeeBefore === ethers.parseEther("0.1"), "payee did not receive exactly 0.1 QIE");
  assert(okPay.policyMatchedChain, "policy prediction disagreed with the chain (in-mandate)");

  // Beat 3 — over-cap attempt is refused on-chain.
  const bigPay = await client.pay(signer, {
    mandateId,
    payee,
    amountQie: "11",
    rationale: "Rehearsal invoice #2 — deliberately above the per-tx cap to prove the chain refuses.",
    reference: "rehearsal-invoice-2",
  });
  out.steps.payOverCap = bigPay;
  console.log(
    `over-cap attempt: intent #${bigPay.intentId} -> ${bigPay.intentStatus} / ${bigPay.refusalReasonCode} (${bigPay.executeTxHash})`
  );
  assert(!bigPay.executed && bigPay.intentStatus === "Refused", "over-cap attempt was not refused");
  assert(bigPay.refusalReasonCode === "OVER_TX_CAP", `expected OVER_TX_CAP, got ${bigPay.refusalReasonCode}`);
  assert(bigPay.policyPrediction === "OVER_TX_CAP" && bigPay.policyMatchedChain, "policy engine did not predict OVER_TX_CAP");

  // Beat 4 — unknown payee is refused on-chain.
  const strangerPay = await client.pay(signer, {
    mandateId,
    payee: STRANGER,
    amountQie: "0.1",
    rationale: "Rehearsal invoice #3 — payee is not on the allowlist; the agent key cannot route around it.",
    reference: "rehearsal-invoice-3",
  });
  out.steps.payUnknownPayee = strangerPay;
  console.log(
    `unknown-payee attempt: intent #${strangerPay.intentId} -> ${strangerPay.intentStatus} / ${strangerPay.refusalReasonCode} (${strangerPay.executeTxHash})`
  );
  assert(!strangerPay.executed && strangerPay.intentStatus === "Refused", "unknown-payee attempt was not refused");
  assert(
    strangerPay.refusalReasonCode === "PAYEE_NOT_ALLOWED",
    `expected PAYEE_NOT_ALLOWED, got ${strangerPay.refusalReasonCode}`
  );
  assert(
    strangerPay.policyPrediction === "PAYEE_NOT_ALLOWED" && strangerPay.policyMatchedChain,
    "policy engine did not predict PAYEE_NOT_ALLOWED"
  );

  // Beat 5 — revoke, then a further attempt is refused MANDATE_REVOKED.
  out.steps.revokeMandate = await client.revokeMandate(signer, { mandateId });
  console.log(`mandate revoked: ${out.steps.revokeMandate.txHash}`);
  const afterRevoke = await client.getMandate(provider, mandateId);
  assert(afterRevoke.status === "Revoked", "mandate not Revoked after revoke");

  const postRevokePay = await client.pay(signer, {
    mandateId,
    payee,
    amountQie: "0.1",
    rationale: "Rehearsal invoice #4 — after the owner revoked the mandate, nothing may pay.",
    reference: "rehearsal-invoice-4",
  });
  out.steps.payAfterRevoke = postRevokePay;
  console.log(
    `post-revoke attempt: intent #${postRevokePay.intentId} -> ${postRevokePay.intentStatus} / ${postRevokePay.refusalReasonCode} (${postRevokePay.executeTxHash})`
  );
  assert(!postRevokePay.executed && postRevokePay.intentStatus === "Refused", "post-revoke attempt was not refused");
  assert(
    postRevokePay.refusalReasonCode === "MANDATE_REVOKED",
    `expected MANDATE_REVOKED, got ${postRevokePay.refusalReasonCode}`
  );
  assert(
    postRevokePay.policyPrediction === "MANDATE_REVOKED" && postRevokePay.policyMatchedChain,
    "policy engine did not predict MANDATE_REVOKED"
  );

  out.mandateId = mandateId;
  out.ranAt = new Date().toISOString();

  const file = path.join(__dirname, "..", "deployments", "testnet.json");
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  dep.stage4 = { ...(dep.stage4 || {}), frontendRehearsal: out };
  fs.writeFileSync(file, JSON.stringify(dep, null, 2) + "\n");

  console.log(JSON.stringify(out, null, 2));
  console.log("FRONTEND REHEARSAL OK");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
