require("@nomicfoundation/hardhat-toolbox");

// Deployer key is read from the environment only. Never hardcode a key here.
// If QIE_DEPLOYER_KEY is unset, networks run read-only / with unlocked nodes.
const QIE_DEPLOYER_KEY = process.env.QIE_DEPLOYER_KEY;
const accounts = QIE_DEPLOYER_KEY ? [QIE_DEPLOYER_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    // QIE Testnet — EVM chain ID 1983. Faucet: https://www.qie.digital/faucet
    qieTestnet: {
      url: process.env.QIE_TESTNET_RPC || "https://rpc1testnet.qie.digital/",
      chainId: 1983,
      accounts,
    },
    // QIE Mainnet — EVM chain ID 1990.
    qieMainnet: {
      url: process.env.QIE_MAINNET_RPC || "https://rpc1mainnet.qie.digital/",
      chainId: 1990,
      accounts,
    },
  },
};
