const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Mock oracle price: $0.50 per QIE, so 1 QIE = $0.50.
// Default mandate: $5 per-tx cap (= 10 QIE), $12 daily cap (= 24 QIE).
const PRICE = ethers.parseEther("0.5");
const PER_TX_CAP = ethers.parseEther("5");
const DAILY_CAP = ethers.parseEther("12");

const Status = { Proposed: 0, Executed: 1, Refused: 2, Expired: 3 };
const Reason = {
  None: 0,
  OverTxCap: 1,
  OverDailyCap: 2,
  PayeeNotAllowed: 3,
  MandateExpired: 4,
  MandatePaused: 5,
  MandateRevoked: 6,
  InsufficientBalance: 7,
  OracleUnavailable: 8,
};

describe("AgentPay Guard (AgentVault + PaymentIntentRegistry)", function () {
  let owner, agent, payee, stranger, funder;
  let registry, oracle, vault;
  let mandateId;

  async function propose(payeeAddr, amountWei, from = agent) {
    const intentHash = ethers.keccak256(ethers.toUtf8Bytes(`invoice-${Date.now()}-${Math.random()}`));
    const rationaleHash = ethers.keccak256(ethers.toUtf8Bytes("test payment"));
    const tx = await registry
      .connect(from)
      .proposeIntent(intentHash, rationaleHash, mandateId, payeeAddr, ethers.ZeroAddress, amountWei);
    await tx.wait();
    return registry.intentCount();
  }

  async function freshMandate({ fundAmount = "20", expiryOffset = 7 * 24 * 3600 } = {}) {
    const now = await time.latest();
    const tx = await vault
      .connect(owner)
      .createMandate(agent.address, PER_TX_CAP, DAILY_CAP, now + expiryOffset);
    await tx.wait();
    const id = await vault.mandateCount();
    if (fundAmount !== "0") {
      await (await vault.connect(owner).fund(id, { value: ethers.parseEther(fundAmount) })).wait();
    }
    return id;
  }

  beforeEach(async function () {
    [owner, agent, payee, stranger, funder] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("PaymentIntentRegistry");
    registry = await Registry.deploy();
    const Oracle = await ethers.getContractFactory("MockOracleCapAdapter");
    oracle = await Oracle.deploy(PRICE);
    const Vault = await ethers.getContractFactory("AgentVault");
    vault = await Vault.deploy(await registry.getAddress(), await oracle.getAddress());

    await (await registry.setVault(await vault.getAddress())).wait();
    // The agent is the registered recorder: it proposes intents.
    await (await registry.setRecorder(agent.address, true)).wait();

    mandateId = await freshMandate();
    await (await vault.connect(owner).addPayee(mandateId, payee.address, "payee.qie")).wait();
  });

  describe("mandate lifecycle", function () {
    it("creates a mandate with the design fields and owner = caller", async function () {
      const m = await vault.getMandate(mandateId);
      expect(m.owner).to.equal(owner.address);
      expect(m.agent).to.equal(agent.address);
      expect(m.perTxCapUsd).to.equal(PER_TX_CAP);
      expect(m.dailyCapUsd).to.equal(DAILY_CAP);
      expect(m.status).to.equal(0); // Active
      expect(m.balance).to.equal(ethers.parseEther("20"));
    });

    it("rejects a mandate with a past expiry or zero caps", async function () {
      const now = await time.latest();
      await expect(
        vault.connect(owner).createMandate(agent.address, PER_TX_CAP, DAILY_CAP, now - 1)
      ).to.be.revertedWithCustomError(vault, "BadMandateParams");
      await expect(
        vault.connect(owner).createMandate(agent.address, 0, DAILY_CAP, now + 3600)
      ).to.be.revertedWithCustomError(vault, "BadMandateParams");
    });

    it("funds the mandate, including from a non-owner funder", async function () {
      await expect(
        vault.connect(funder).fund(mandateId, { value: ethers.parseEther("3") })
      ).to.changeEtherBalance(vault, ethers.parseEther("3"));
      const m = await vault.getMandate(mandateId);
      expect(m.balance).to.equal(ethers.parseEther("23"));
    });

    it("adds and removes payees (owner only), storing the .qie name", async function () {
      expect(await vault.isPayee(mandateId, payee.address)).to.equal(true);
      expect(await vault.payeeName(mandateId, payee.address)).to.equal("payee.qie");

      await expect(vault.connect(stranger).addPayee(mandateId, stranger.address, ""))
        .to.be.revertedWithCustomError(vault, "NotOwner");
      await expect(vault.connect(stranger).removePayee(mandateId, payee.address))
        .to.be.revertedWithCustomError(vault, "NotOwner");

      await (await vault.connect(owner).removePayee(mandateId, payee.address)).wait();
      expect(await vault.isPayee(mandateId, payee.address)).to.equal(false);
      expect(await vault.getPayees(mandateId)).to.have.lengthOf(0);
    });
  });

  describe("execution", function () {
    it("pays an in-mandate payment and marks the intent Executed", async function () {
      const amount = ethers.parseEther("4"); // $2.00 at the mock price
      const intentId = await propose(payee.address, amount);

      await expect(vault.connect(agent).executePayment(mandateId, payee.address, amount, intentId))
        .to.changeEtherBalance(payee, amount);

      const intent = await registry.getIntent(intentId);
      expect(intent.status).to.equal(Status.Executed);
      expect(intent.refusalReason).to.equal(Reason.None);

      const m = await vault.getMandate(mandateId);
      expect(m.balance).to.equal(ethers.parseEther("16"));
      expect(await vault.spentInWindow(mandateId)).to.equal(ethers.parseEther("2"));
    });

    it("is agent-only: owner and strangers cannot execute", async function () {
      const amount = ethers.parseEther("1");
      const intentId = await propose(payee.address, amount);
      await expect(vault.connect(owner).executePayment(mandateId, payee.address, amount, intentId))
        .to.be.revertedWithCustomError(vault, "NotAgent");
      await expect(vault.connect(stranger).executePayment(mandateId, payee.address, amount, intentId))
        .to.be.revertedWithCustomError(vault, "NotAgent");
    });

    it("reverts when the intent does not match the payment", async function () {
      const intentId = await propose(payee.address, ethers.parseEther("1"));
      await expect(
        vault.connect(agent).executePayment(mandateId, payee.address, ethers.parseEther("2"), intentId)
      ).to.be.revertedWithCustomError(vault, "IntentMismatch");
    });

    it("refuses a removed payee with PAYEE_NOT_ALLOWED", async function () {
      await (await vault.connect(owner).removePayee(mandateId, payee.address)).wait();
      const amount = ethers.parseEther("1");
      const intentId = await propose(payee.address, amount);
      const tx = await vault.connect(agent).executePayment(mandateId, payee.address, amount, intentId);
      await tx.wait();
      const intent = await registry.getIntent(intentId);
      expect(intent.status).to.equal(Status.Refused);
      expect(intent.refusalReason).to.equal(Reason.PayeeNotAllowed);
    });
  });

  describe("refusals are recorded, not reverted", function () {
    async function expectRefusal(amount, reason, payeeAddr = payee.address) {
      const intentId = await propose(payeeAddr, amount);
      const payeeBefore = await ethers.provider.getBalance(payeeAddr);
      const tx = await vault.connect(agent).executePayment(mandateId, payeeAddr, amount, intentId);
      const receipt = await tx.wait();
      expect(receipt.status).to.equal(1); // recorded on-chain, NOT a revert
      const intent = await registry.getIntent(intentId);
      expect(intent.status).to.equal(Status.Refused);
      expect(intent.refusalReason).to.equal(reason);
      expect(await ethers.provider.getBalance(payeeAddr)).to.equal(payeeBefore); // unpaid
      return intentId;
    }

    it("over per-tx cap -> OVER_TX_CAP", async function () {
      await expectRefusal(ethers.parseEther("11"), Reason.OverTxCap); // $5.50 > $5
      expect(await registry.refusalReasonCode(Reason.OverTxCap)).to.equal("OVER_TX_CAP");
    });

    it("over daily cap across several payments -> OVER_DAILY_CAP", async function () {
      // Fund deep enough that the balance never binds in this test.
      mandateId = await freshMandate({ fundAmount: "40" });
      await (await vault.connect(owner).addPayee(mandateId, payee.address, "")).wait();
      // Two $5 payments land ($10 of the $12 daily cap)...
      for (let i = 0; i < 2; i++) {
        const amount = ethers.parseEther("10");
        const id = await propose(payee.address, amount);
        await (await vault.connect(agent).executePayment(mandateId, payee.address, amount, id)).wait();
      }
      expect(await vault.spentInWindow(mandateId)).to.equal(ethers.parseEther("10"));
      // ...a further $2.50 would take the window to $12.50 > $12.
      await expectRefusal(ethers.parseEther("5"), Reason.OverDailyCap);

      // The window is rolling: 24h later the same payment succeeds.
      await time.increase(24 * 3600 + 1);
      const amount = ethers.parseEther("5");
      const id = await propose(payee.address, amount);
      await expect(vault.connect(agent).executePayment(mandateId, payee.address, amount, id))
        .to.changeEtherBalance(payee, amount);
    });

    it("unknown payee -> PAYEE_NOT_ALLOWED", async function () {
      await expectRefusal(ethers.parseEther("1"), Reason.PayeeNotAllowed, stranger.address);
    });

    it("expired mandate -> MANDATE_EXPIRED", async function () {
      mandateId = await freshMandate({ expiryOffset: 3600 });
      await (await vault.connect(owner).addPayee(mandateId, payee.address, "")).wait();
      await time.increase(3601);
      await expectRefusal(ethers.parseEther("1"), Reason.MandateExpired);
    });

    it("paused mandate -> MANDATE_PAUSED, and resume restores payments", async function () {
      await (await vault.connect(owner).pauseMandate(mandateId)).wait();
      await expectRefusal(ethers.parseEther("1"), Reason.MandatePaused);

      await (await vault.connect(owner).resumeMandate(mandateId)).wait();
      const amount = ethers.parseEther("1");
      const id = await propose(payee.address, amount);
      await expect(vault.connect(agent).executePayment(mandateId, payee.address, amount, id))
        .to.changeEtherBalance(payee, amount);
    });

    it("revoked mandate -> MANDATE_REVOKED", async function () {
      await (await vault.connect(owner).revokeMandate(mandateId)).wait();
      await expectRefusal(ethers.parseEther("1"), Reason.MandateRevoked);
    });

    it("amount within caps but above the funded balance -> INSUFFICIENT_BALANCE", async function () {
      mandateId = await freshMandate({ fundAmount: "1" }); // only 1 QIE funded
      await (await vault.connect(owner).addPayee(mandateId, payee.address, "")).wait();
      // 4 QIE = $2.00, inside both caps, but the mandate holds only 1 QIE.
      await expectRefusal(ethers.parseEther("4"), Reason.InsufficientBalance);
    });

    it("oracle down or stale -> ORACLE_UNAVAILABLE (fails closed)", async function () {
      await (await oracle.setAvailable(false)).wait();
      await expectRefusal(ethers.parseEther("1"), Reason.OracleUnavailable);

      await (await oracle.setAvailable(true)).wait();
      await (await oracle.setStale(true)).wait();
      await expectRefusal(ethers.parseEther("1"), Reason.OracleUnavailable);
    });
  });

  describe("registry guards and intent expiry", function () {
    it("only the vault and registered recorders may write", async function () {
      await expect(
        registry
          .connect(stranger)
          .proposeIntent(ethers.ZeroHash, ethers.ZeroHash, mandateId, payee.address, ethers.ZeroAddress, 1)
      ).to.be.revertedWithCustomError(registry, "NotWriter");
      const intentId = await propose(payee.address, ethers.parseEther("1"));
      await expect(registry.connect(stranger).markRefused(intentId, Reason.OverTxCap))
        .to.be.revertedWithCustomError(registry, "NotVault");
      await expect(registry.connect(stranger).setRecorder(stranger.address, true))
        .to.be.revertedWithCustomError(registry, "NotOwner");
    });

    it("expires a stale Proposed intent, which then cannot execute", async function () {
      const amount = ethers.parseEther("1");
      const intentId = await propose(payee.address, amount);
      await time.increase(3601); // past INTENT_TTL (1h)
      await (await registry.connect(agent).expireIntent(intentId)).wait();
      const intent = await registry.getIntent(intentId);
      expect(intent.status).to.equal(Status.Expired);
      await expect(vault.connect(agent).executePayment(mandateId, payee.address, amount, intentId))
        .to.be.revertedWithCustomError(vault, "IntentMismatch");
    });
  });

  describe("withdrawal", function () {
    it("returns unspent funds to the owner only", async function () {
      await expect(vault.connect(stranger).withdrawUnspent(mandateId, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(vault, "NotOwner");
      // The agent can never withdraw either.
      await expect(vault.connect(agent).withdrawUnspent(mandateId, ethers.parseEther("1")))
        .to.be.revertedWithCustomError(vault, "NotOwner");

      await expect(vault.connect(owner).withdrawUnspent(mandateId, ethers.parseEther("6")))
        .to.changeEtherBalance(owner, ethers.parseEther("6"));
      const m = await vault.getMandate(mandateId);
      expect(m.balance).to.equal(ethers.parseEther("14"));
    });

    it("owner can still withdraw after revoking", async function () {
      await (await vault.connect(owner).revokeMandate(mandateId)).wait();
      await expect(vault.connect(owner).withdrawUnspent(mandateId, ethers.parseEther("20")))
        .to.changeEtherBalance(owner, ethers.parseEther("20"));
    });

    it("rejects withdrawing more than the balance", async function () {
      await expect(vault.connect(owner).withdrawUnspent(mandateId, ethers.parseEther("21")))
        .to.be.revertedWithCustomError(vault, "BadAmount");
    });
  });
});
