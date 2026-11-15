// Stage 3: deploy the real OracleCapAdapter to QIE testnet and prove the
// fail-closed wiring end to end.
//
// The adapter points at the QIE Oracle QIE/USD feed
// (0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17). That feed is live on QIE
// MAINNET (AggregatorV3, 8 decimals, "QIE / USDT" — probed read-only) but
// does NOT exist on testnet (no code at the address), so on testnet the
// adapter must report unavailable. This script verifies exactly that, then:
//   1. swaps the vault's adapter to the real one (vault admin = deployer),
//   2. runs one payment attempt on a fresh mandate -> the vault must refuse
//      it with ORACLE_UNAVAILABLE, recorded in the registry,
//   3. swaps the vault back to the mock adapter (restored in a finally, so
//      the testnet demo deployment is left exactly as Stage 2 had it).
// Results are merged into deployments/testnet.json under `stage3`.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const FEED = "0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17"; // QIE Oracle QIE/USD (mainnet)
const MAX_STALENESS = 86400; // 24h — the mainnet QIE feed updates on a multi-hour cadence

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
    throw new Error(`deploy_adapter.js is for qieTestnet only (got ${network.name})`);
  }
  const file = path.join(__dirname, "..", "deployments", "testnet.json");
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));

  const [deployer] = await ethers.getSigners();
  const vault = await ethers.getContractAt("AgentVault", dep.contracts.AgentVault);
  const registry = await ethers.getContractAt("PaymentIntentRegistry", dep.contracts.PaymentIntentRegistry);
  const mockAdapter = dep.contracts.MockOracleCapAdapter;
  if ((await vault.oracleAdapter()).toLowerCase() !== mockAdapter.toLowerCase()) {
    throw new Error("vault is not wired to the Stage 2 mock adapter — unexpected starting state");
  }

  const Adapter = await ethers.getContractFactory("OracleCapAdapter");
  const adapter = await Adapter.deploy(FEED, MAX_STALENESS);
  await adapter.waitForDeployment();
  const adapterAddr = await adapter.getAddress();
  const availableOnTestnet = await adapter.isAvailable();
  console.log(`OracleCapAdapter: ${adapterAddr}  isAvailable on testnet: ${availableOnTestnet}`);
  if (availableOnTestnet) {
    throw new Error("adapter reports available on testnet — the feed should not exist there");
  }

  const payee = ethers.HDNodeWallet.fromPhrase(readMnemonic(), undefined, "m/44'/60'/0'/0/1").address;
  const wiring = { adapter: adapterAddr };
  try {
    const swapTx = await vault.setOracleAdapter(adapterAddr);
    await swapTx.wait();
    wiring.swapTx = swapTx.hash;

    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const createTx = await vault.createMandate(
      deployer.address,
      ethers.parseEther("5"),
      ethers.parseEther("12"),
      now + 7 * 24 * 3600
    );
    await createTx.wait();
    wiring.mandateId = (await vault.mandateCount()).toString();

    const fundTx = await vault.fund(wiring.mandateId, { value: ethers.parseEther("0.05") });
    await fundTx.wait();
    wiring.fundTx = fundTx.hash;

    const addTx = await vault.addPayee(wiring.mandateId, payee, "wiring.qie");
    await addTx.wait();
    wiring.addPayeeTx = addTx.hash;

    const amount = ethers.parseEther("0.01");
    const proposeTx = await registry.proposeIntent(
      ethers.keccak256(ethers.toUtf8Bytes("stage3 wiring check")),
      ethers.keccak256(ethers.toUtf8Bytes("real-adapter wiring check: must refuse, no testnet feed")),
      wiring.mandateId,
      payee,
      ethers.ZeroAddress,
      amount
    );
    await proposeTx.wait();
    wiring.proposeTx = proposeTx.hash;
    wiring.intentId = (await registry.intentCount()).toString();

    const execTx = await vault.executePayment(wiring.mandateId, payee, amount, wiring.intentId);
    await execTx.wait();
    wiring.executeTx = execTx.hash;

    const intent = await registry.getIntent(wiring.intentId);
    wiring.intentStatus = Number(intent.status); // 2 = Refused
    wiring.refusalReasonCode = await registry.refusalReasonCode(intent.refusalReason);
    if (wiring.intentStatus !== 2 || wiring.refusalReasonCode !== "ORACLE_UNAVAILABLE") {
      throw new Error(`wiring check: expected ORACLE_UNAVAILABLE refusal, got ${wiring.refusalReasonCode}`);
    }
  } finally {
    // Always restore the mock adapter so the testnet demo keeps working.
    const backTx = await vault.setOracleAdapter(mockAdapter);
    await backTx.wait();
    wiring.swapBackTx = backTx.hash;
    if ((await vault.oracleAdapter()).toLowerCase() !== mockAdapter.toLowerCase()) {
      throw new Error("failed to restore the mock adapter on the vault");
    }
  }

  dep.stage3 = {
    ...(dep.stage3 || {}),
    oracleCapAdapter: {
      address: adapterAddr,
      deployTx: adapter.deploymentTransaction().hash,
      feed: FEED,
      maxStalenessSeconds: MAX_STALENESS,
      availableOnTestnet: false,
      note: "Feed is live on QIE mainnet only; on testnet the adapter fails closed by design.",
    },
    wiringCheck: wiring,
  };
  fs.writeFileSync(file, JSON.stringify(dep, null, 2) + "\n");
  console.log(JSON.stringify(dep.stage3, null, 2));
  console.log("ADAPTER DEPLOY + WIRING CHECK OK");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
