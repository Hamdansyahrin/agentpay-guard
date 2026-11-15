// Live smoke flow against the QIE testnet deployment (deployments/testnet.json):
//   1. create a mandate ($5 per-tx / $12 daily caps, mock price $0.50/QIE)
//   2. fund it with 1.5 testnet QIE (the wallet holds ~2; gas is ~free)
//   3. add a payee (the wallet's own second account, so funds stay recoverable)
//   4. propose + execute an in-mandate payment of 1 QIE -> intent Executed
//   5. propose + attempt an 11 QIE payment ($5.50) -> refused OVER_TX_CAP,
//      and the refusal is read back from the registry as proof
// Results are merged into deployments/testnet.json under `smoke`.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

function readMnemonic() {
  const raw = fs.readFileSync(path.join(__dirname, "..", ".qie-testnet-wallet.secret"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*mnemonic\s*:\s*(.+)\s*$/);
    if (m) return m[1];
  }
  throw new Error("mnemonic not found in wallet file");
}

async function main() {
  if (network.name !== "qieTestnet") {
    throw new Error(`smoke.js is for qieTestnet only (got ${network.name})`);
  }
  const file = path.join(__dirname, "..", "deployments", "testnet.json");
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));

  const [deployer] = await ethers.getSigners(); // owner + agent + recorder
  const payeeWallet = ethers.HDNodeWallet.fromPhrase(readMnemonic(), undefined, "m/44'/60'/0'/0/1");
  const payee = payeeWallet.address;

  const registry = await ethers.getContractAt("PaymentIntentRegistry", dep.contracts.PaymentIntentRegistry);
  const vault = await ethers.getContractAt("AgentVault", dep.contracts.AgentVault);

  const txs = {};
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const createTx = await vault.createMandate(
    deployer.address,
    ethers.parseEther("5"), // $5 per-tx cap
    ethers.parseEther("12"), // $12 daily cap
    now + 7 * 24 * 3600
  );
  await createTx.wait();
  txs.createMandate = createTx.hash;
  const mandateId = await vault.mandateCount();

  const fundTx = await vault.fund(mandateId, { value: ethers.parseEther("1.5") });
  await fundTx.wait();
  txs.fund = fundTx.hash;

  const addTx = await vault.addPayee(mandateId, payee, "smoke.qie");
  await addTx.wait();
  txs.addPayee = addTx.hash;

  async function propose(payeeAddr, amountWei, label) {
    const tx = await registry.proposeIntent(
      ethers.keccak256(ethers.toUtf8Bytes(`smoke:${label}`)),
      ethers.keccak256(ethers.toUtf8Bytes(`smoke rationale: ${label}`)),
      mandateId,
      payeeAddr,
      ethers.ZeroAddress,
      amountWei
    );
    await tx.wait();
    return { intentId: await registry.intentCount(), proposeTx: tx.hash };
  }

  // 4. In-mandate payment: 0.5 QIE = $0.25, inside both caps.
  const okAmount = ethers.parseEther("0.5");
  const ok = await propose(payee, okAmount, "in-mandate payment");
  const payeeBefore = await ethers.provider.getBalance(payee);
  const execTx = await vault.executePayment(mandateId, payee, okAmount, ok.intentId);
  await execTx.wait();
  const okIntent = await registry.getIntent(ok.intentId);
  const payeeAfter = await ethers.provider.getBalance(payee);

  // 5. Over-cap attempt: 11 QIE = $5.50 > $5 per-tx cap.
  const bigAmount = ethers.parseEther("11");
  const big = await propose(payee, bigAmount, "over-cap attempt");
  const refuseTx = await vault.executePayment(mandateId, payee, bigAmount, big.intentId);
  await refuseTx.wait();
  const bigIntent = await registry.getIntent(big.intentId);
  const reasonCode = await registry.refusalReasonCode(bigIntent.refusalReason);

  const smoke = {
    mandateId: mandateId.toString(),
    payee,
    txs: { ...txs, proposeOk: ok.proposeTx, executeOk: execTx.hash, proposeOverCap: big.proposeTx, executeOverCap: refuseTx.hash },
    inMandatePayment: {
      intentId: ok.intentId.toString(),
      amountQie: "0.5",
      intentStatus: Number(okIntent.status), // 1 = Executed
      payeeReceivedWei: (payeeAfter - payeeBefore).toString(),
    },
    overCapAttempt: {
      intentId: big.intentId.toString(),
      amountQie: "11",
      intentStatus: Number(bigIntent.status), // 2 = Refused
      refusalReasonCode: reasonCode,
      txStatus: refuseTx ? "mined (refusal recorded, no revert)" : "n/a",
    },
    ranAt: new Date().toISOString(),
  };

  if (smoke.inMandatePayment.intentStatus !== 1) throw new Error("smoke: in-mandate intent not Executed");
  if (smoke.inMandatePayment.payeeReceivedWei !== okAmount.toString()) throw new Error("smoke: payee did not receive the payment");
  if (smoke.overCapAttempt.intentStatus !== 2 || reasonCode !== "OVER_TX_CAP") {
    throw new Error(`smoke: over-cap attempt not refused as OVER_TX_CAP (got ${reasonCode})`);
  }

  dep.smoke = smoke;
  fs.writeFileSync(file, JSON.stringify(dep, null, 2) + "\n");
  console.log(JSON.stringify(smoke, null, 2));
  console.log("SMOKE OK");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
