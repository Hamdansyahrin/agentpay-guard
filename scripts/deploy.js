// Deploys AgentPay Guard to QIE testnet (chainId 1983):
// PaymentIntentRegistry + MockOracleCapAdapter + AgentVault, wires the
// vault into the registry, and registers the deployer as an agent recorder
// (the dedicated testnet wallet plays owner/agent/recorder for the smoke run).
// Writes deployments/testnet.json. The real OracleCapAdapter is stage 3.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  if (network.name !== "qieTestnet") {
    throw new Error(`deploy.js is for qieTestnet only (got ${network.name})`);
  }
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`deployer: ${deployer.address}  balance: ${ethers.formatEther(balance)} QIE`);

  // Mock price for the testnet demo (the real feed adapter is stage 3).
  const mockPrice = ethers.parseEther(process.env.MOCK_QIE_PRICE_USD || "0.5");

  const Registry = await ethers.getContractFactory("PaymentIntentRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();

  const Oracle = await ethers.getContractFactory("MockOracleCapAdapter");
  const oracle = await Oracle.deploy(mockPrice);
  await oracle.waitForDeployment();

  const Vault = await ethers.getContractFactory("AgentVault");
  const vault = await Vault.deploy(await registry.getAddress(), await oracle.getAddress());
  await vault.waitForDeployment();

  const setVaultTx = await registry.setVault(await vault.getAddress());
  await setVaultTx.wait();
  const setRecorderTx = await registry.setRecorder(deployer.address, true);
  await setRecorderTx.wait();

  const out = {
    network: "qieTestnet",
    chainId: 1983,
    explorer: "https://testnet.qie.digital",
    deployer: deployer.address,
    mockPriceUsdPerQie: ethers.formatEther(mockPrice),
    contracts: {
      PaymentIntentRegistry: await registry.getAddress(),
      MockOracleCapAdapter: await oracle.getAddress(),
      AgentVault: await vault.getAddress(),
    },
    deployTx: {
      PaymentIntentRegistry: registry.deploymentTransaction().hash,
      MockOracleCapAdapter: oracle.deploymentTransaction().hash,
      AgentVault: vault.deploymentTransaction().hash,
    },
    wiringTx: { setVault: setVaultTx.hash, setRecorder: setRecorderTx.hash },
    deployedAt: new Date().toISOString(),
  };

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "testnet.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
