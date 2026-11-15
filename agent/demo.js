#!/usr/bin/env node
// AgentPay Guard — scripted agent demo (Stage 3), run against the live QIE
// testnet deployment from deployments/testnet.json.
//
//   node agent/demo.js
//
// The flow (DESIGN.md §5, testnet edition):
//   1. create a mandate ($5 per-tx / $12 daily caps, 7-day expiry)
//   2. fund it with 0.25 testnet QIE and register the payee as demo.qie
//   3. the agent reads the mandate back through its own tool (get_mandate)
//   4. in-cap payment: propose 0.1 QIE -> policy says ok -> execute ->
//      intent Executed on-chain, payee balance +0.1 QIE
//   5. over-cap payment: propose 11 QIE ($5.50 at the $0.50 mock price) ->
//      policy predicts OVER_TX_CAP -> execute anyway -> the vault refuses
//      ON-CHAIN and the registry records Refused / OVER_TX_CAP
// Results are merged into deployments/testnet.json under stage3.agentDemo.
// The wallet plays owner + agent + recorder on testnet (see lib.js header).
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { connect, demoPayeeAddress, TOOLS } = require("./lib");

function assert(cond, msg) {
  if (!cond) throw new Error(`demo assertion failed: ${msg}`);
}

async function main() {
  const ctx = await connect();
  const payee = demoPayeeAddress();
  const out = { payee, steps: {} };
  console.log(`agent wallet: ${ctx.signer.address}`);
  console.log(`payee (demo.qie): ${payee}`);

  // 1–2. Owner-side setup through the agent tools.
  const created = await TOOLS.create_mandate.run(ctx, { perTxCapUsd: "5", dailyCapUsd: "12", expiryDays: 7 });
  out.steps.createMandate = created;
  const mandateId = created.mandateId;
  console.log(`mandate #${mandateId} created: ${created.txHash}`);

  out.steps.fundMandate = await TOOLS.fund_mandate.run(ctx, { mandateId, amountQie: "0.25" });
  console.log(`funded 0.25 QIE: ${out.steps.fundMandate.txHash}`);

  out.steps.addPayee = await TOOLS.add_payee.run(ctx, { mandateId, payee, qieName: "demo.qie" });
  console.log(`payee added: ${out.steps.addPayee.txHash}`);

  // 3. The agent reads its own mandate/caps before acting.
  out.steps.readMandate = await TOOLS.get_mandate.run(ctx, { mandateId });
  console.log(
    `mandate read: caps $${out.steps.readMandate.perTxCapUsd}/tx, $${out.steps.readMandate.dailyCapUsd}/day, ` +
      `balance ${out.steps.readMandate.balanceQie} QIE, oracle price $${out.steps.readMandate.oracle.qiePriceUsd}/QIE`
  );
  assert(out.steps.readMandate.status === "Active", "mandate not Active");
  assert(out.steps.readMandate.payees.length === 1, "payee not registered");

  // 4. In-cap payment: 0.1 QIE = $0.05 at the mock price — executes.
  const okProp = await TOOLS.propose_payment.run(ctx, {
    mandateId,
    payee,
    amountQie: "0.1",
    rationale: "Demo invoice #1 — inside the mandate caps, paying demo.qie for services.",
    reference: "demo-invoice-1",
  });
  out.steps.proposeInCap = okProp;
  const payeeBefore = await ctx.provider.getBalance(payee);
  const okExec = await TOOLS.execute_payment.run(ctx, { mandateId, payee, amountQie: "0.1", intentId: okProp.intentId });
  out.steps.executeInCap = okExec;
  const payeeAfter = await ctx.provider.getBalance(payee);
  console.log(`in-cap payment: intent #${okProp.intentId} -> ${okExec.intentStatus} (${okExec.txHash})`);
  assert(okExec.executed && okExec.intentStatus === "Executed", "in-cap payment did not execute");
  assert(payeeAfter - payeeBefore === ethers.parseEther("0.1"), "payee did not receive exactly 0.1 QIE");
  assert(okExec.policyMatchedChain, "policy prediction disagreed with the chain");

  // 5. Over-cap attempt: 11 QIE = $5.50 > $5 per-tx cap — refused on-chain.
  const bigProp = await TOOLS.propose_payment.run(ctx, {
    mandateId,
    payee,
    amountQie: "11",
    rationale: "Demo invoice #2 — deliberately above the per-tx cap to prove the chain refuses.",
    reference: "demo-invoice-2",
  });
  out.steps.proposeOverCap = bigProp;
  const bigExec = await TOOLS.execute_payment.run(ctx, { mandateId, payee, amountQie: "11", intentId: bigProp.intentId });
  out.steps.executeOverCap = bigExec;
  console.log(
    `over-cap attempt: intent #${bigProp.intentId} -> ${bigExec.intentStatus} / ${bigExec.refusalReasonCode} (${bigExec.txHash})`
  );
  assert(!bigExec.executed && bigExec.intentStatus === "Refused", "over-cap attempt was not refused");
  assert(bigExec.refusalReasonCode === "OVER_TX_CAP", `expected OVER_TX_CAP, got ${bigExec.refusalReasonCode}`);
  assert(bigExec.policyPrediction === "OVER_TX_CAP" && bigExec.policyMatchedChain, "policy engine did not predict the refusal");

  out.mandateId = mandateId;
  out.ranAt = new Date().toISOString();

  const file = path.join(__dirname, "..", "deployments", "testnet.json");
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  dep.stage3 = { ...(dep.stage3 || {}), agentDemo: out };
  fs.writeFileSync(file, JSON.stringify(dep, null, 2) + "\n");

  console.log(JSON.stringify(out, null, 2));
  console.log("AGENT DEMO OK");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
