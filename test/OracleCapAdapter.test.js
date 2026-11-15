const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// The mock feed replays the real QIE mainnet feed's shape and a real answer
// observed read-only on 2026-11-15: AggregatorV3, 8 decimals,
// answer 15499659 = $0.15499659 per QIE.
const FEED_DECIMALS = 8;
const ANSWER = 15499659n;
const MAX_STALENESS = 3600; // 1h in tests (mainnet deploys use 24h — see adapter NatSpec)

describe("OracleCapAdapter (real QIE Oracle adapter)", function () {
  let feed, adapter;

  async function deployFeed(decimals = FEED_DECIMALS, answer = ANSWER) {
    const now = await time.latest();
    const Feed = await ethers.getContractFactory("MockAggregatorV3");
    return Feed.deploy(decimals, answer, now);
  }

  async function deployAdapter(feedAddr, staleness = MAX_STALENESS) {
    const Adapter = await ethers.getContractFactory("OracleCapAdapter");
    return Adapter.deploy(feedAddr, staleness);
  }

  beforeEach(async function () {
    feed = await deployFeed();
    adapter = await deployAdapter(await feed.getAddress());
  });

  it("converts at a fresh price, honouring the feed's 8 decimals", async function () {
    expect(await adapter.isAvailable()).to.equal(true);
    // 1 QIE at $0.15499659 -> $0.15499659 (18-dec USD)
    expect(await adapter.usdValueOf(ethers.parseEther("1"))).to.equal(154996590000000000n);
    // 10 QIE -> $1.5499659
    expect(await adapter.usdValueOf(ethers.parseEther("10"))).to.equal(1549965900000000000n);
    expect(await adapter.usdValueOf(0)).to.equal(0n);
  });

  it("reads decimals from the feed instead of assuming 8", async function () {
    const feed18 = await deployFeed(18, ethers.parseEther("0.155"));
    const adapter18 = await deployAdapter(await feed18.getAddress());
    expect(await adapter18.isAvailable()).to.equal(true);
    expect(await adapter18.usdValueOf(ethers.parseEther("1"))).to.equal(ethers.parseEther("0.155"));
  });

  it("fails closed on a stale price", async function () {
    const now = await time.latest();
    await (await feed.setUpdatedAt(now - MAX_STALENESS - 1)).wait();
    expect(await adapter.isAvailable()).to.equal(false);
    await expect(adapter.usdValueOf(ethers.parseEther("1")))
      .to.be.revertedWithCustomError(adapter, "PriceUnavailable");
  });

  it("accepts a round exactly at the staleness boundary", async function () {
    const now = await time.latest();
    // +1s: the setUpdatedAt tx itself mines a block one second later, so the
    // round's age at read time lands exactly on MAX_STALENESS (age > bound is
    // what fails; age == bound still passes).
    await (await feed.setUpdatedAt(now - MAX_STALENESS + 1)).wait();
    expect(await adapter.isAvailable()).to.equal(true);
  });

  it("fails closed on a zero answer", async function () {
    await (await feed.setAnswer(0)).wait();
    expect(await adapter.isAvailable()).to.equal(false);
    await expect(adapter.usdValueOf(ethers.parseEther("1")))
      .to.be.revertedWithCustomError(adapter, "PriceUnavailable");
  });

  it("fails closed on a negative answer", async function () {
    await (await feed.setAnswer(-1)).wait();
    expect(await adapter.isAvailable()).to.equal(false);
    await expect(adapter.usdValueOf(ethers.parseEther("1")))
      .to.be.revertedWithCustomError(adapter, "PriceUnavailable");
  });

  it("fails closed when the feed reverts (dead feed)", async function () {
    await (await feed.setReverts(true)).wait();
    expect(await adapter.isAvailable()).to.equal(false);
    await expect(adapter.usdValueOf(ethers.parseEther("1")))
      .to.be.revertedWithCustomError(adapter, "PriceUnavailable");
  });

  it("fails closed on an incomplete round (answeredInRound < roundId)", async function () {
    const now = await time.latest();
    await (await feed.setRound(7, ANSWER, now, 6)).wait();
    expect(await adapter.isAvailable()).to.equal(false);
  });

  it("fails closed on a zero or future updatedAt", async function () {
    await (await feed.setUpdatedAt(0)).wait();
    expect(await adapter.isAvailable()).to.equal(false);

    const now = await time.latest();
    await (await feed.setUpdatedAt(now + 3600)).wait();
    expect(await adapter.isAvailable()).to.equal(false);
  });

  it("fails closed when the feed address has no code (the testnet case)", async function () {
    const [, nobody] = await ethers.getSigners();
    const adapterNoFeed = await deployAdapter(nobody.address);
    expect(await adapterNoFeed.isAvailable()).to.equal(false);
    await expect(adapterNoFeed.usdValueOf(ethers.parseEther("1")))
      .to.be.revertedWithCustomError(adapterNoFeed, "PriceUnavailable");
  });

  it("rejects a zero feed address or zero staleness at deploy time", async function () {
    const Adapter = await ethers.getContractFactory("OracleCapAdapter");
    await expect(Adapter.deploy(ethers.ZeroAddress, MAX_STALENESS))
      .to.be.revertedWithCustomError(adapter, "BadAdapterParams");
    await expect(Adapter.deploy(await feed.getAddress(), 0))
      .to.be.revertedWithCustomError(adapter, "BadAdapterParams");
  });

  describe("wired into AgentVault", function () {
    let owner, agent, payee;
    let registry, vault, mandateId;

    beforeEach(async function () {
      [owner, agent, payee] = await ethers.getSigners();
      const Registry = await ethers.getContractFactory("PaymentIntentRegistry");
      registry = await Registry.deploy();
      const Vault = await ethers.getContractFactory("AgentVault");
      vault = await Vault.deploy(await registry.getAddress(), await adapter.getAddress());
      await (await registry.setVault(await vault.getAddress())).wait();
      await (await registry.setRecorder(agent.address, true)).wait();

      const now = await time.latest();
      await (
        await vault.connect(owner).createMandate(
          agent.address,
          ethers.parseEther("5"), // $5 per-tx cap
          ethers.parseEther("12"), // $12 daily cap
          now + 7 * 24 * 3600
        )
      ).wait();
      mandateId = await vault.mandateCount();
      await (await vault.connect(owner).fund(mandateId, { value: ethers.parseEther("20") })).wait();
      await (await vault.connect(owner).addPayee(mandateId, payee.address, "payee.qie")).wait();
    });

    async function proposeAndExecute(amountWei) {
      const tx = await registry
        .connect(agent)
        .proposeIntent(
          ethers.keccak256(ethers.toUtf8Bytes(`adapter-test-${Date.now()}-${Math.random()}`)),
          ethers.keccak256(ethers.toUtf8Bytes("adapter integration payment")),
          mandateId,
          payee.address,
          ethers.ZeroAddress,
          amountWei
        );
      await tx.wait();
      const intentId = await registry.intentCount();
      await (await vault.connect(agent).executePayment(mandateId, payee.address, amountWei, intentId)).wait();
      return registry.getIntent(intentId);
    }

    it("executes an in-cap payment converted at the real feed price", async function () {
      // 10 QIE = $1.5499659 at the replayed price — inside the $5 cap.
      const intent = await proposeAndExecute(ethers.parseEther("10"));
      expect(intent.status).to.equal(1); // Executed
      expect(await vault.spentInWindow(mandateId)).to.equal(1549965900000000000n);
    });

    it("refuses ORACLE_UNAVAILABLE once the feed goes stale", async function () {
      const now = await time.latest();
      await (await feed.setUpdatedAt(now - MAX_STALENESS - 60)).wait();
      const intent = await proposeAndExecute(ethers.parseEther("1"));
      expect(intent.status).to.equal(2); // Refused
      expect(intent.refusalReason).to.equal(8); // OracleUnavailable
      expect(await registry.refusalReasonCode(intent.refusalReason)).to.equal("ORACLE_UNAVAILABLE");
    });
  });
});
