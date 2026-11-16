// AgentPay Guard — shared chain module for the front end (Stage 4).
//
// EVERY chain interaction of the web app goes through this one module:
// the page (app.js) uses it with a wallet signer, and the Node rehearsal
// script (rehearse.js) imports it unchanged with the project testnet
// wallet — so the demo a judge clicks through is the exact code path the
// rehearsal proves on-chain. No call logic is duplicated anywhere else.
//
// It mirrors the Stage 3 agent library (agent/lib.js): the policy engine
// below is the same deterministic check, in the same order the vault's
// AgentVault._evaluate runs on-chain, predicting the same refusal codes.
// The chain remains the arbiter — executePayment submits anyway and the
// registry's recorded outcome is the verdict that counts.
//
// TESTNET ONLY: write helpers refuse any chain other than QIE testnet
// (1983), like the agent library. Deployment addresses below are the
// Stage 2/3 testnet deployment (deployments/testnet.json).
//
// Browser usage:  const client = AgentPay.createClient(window.ethers);
// Node usage:     const { createClient } = require("./agentpay");
//                 const client = createClient(require("ethers"));
(function (global) {
  "use strict";

  var CONFIG = {
    chainId: 1983,
    chainIdHex: "0x7bf",
    networkName: "QIE Testnet",
    rpcUrl: "https://rpc1testnet.qie.digital/",
    explorerUrl: "https://testnet.qie.digital",
    faucetUrl: "https://www.qie.digital/faucet",
    // Hosted read-only QIE Wallet MCP (DESIGN.md §4) — the .qie name
    // resolution path. Name lookups there are mainnet-only (see NOTES).
    mcpUrl: "https://mcp.qie.digital/mcp",
    contracts: {
      AgentVault: "0x51089D7ad167Df432b4fEb55F7698D84454C90f9",
      PaymentIntentRegistry: "0xe8Bc30b3edFa330Df5Cb727D5E6F431cB1932efc",
      MockOracleCapAdapter: "0x13245B988d57824c123069bD306d18D7e30E7b52",
      OracleCapAdapter: "0xD66F7d954865BfBC3457CeD5FCD5270624157f21",
    },
  };

  var VAULT_ABI = [
    "function createMandate(address agent, uint256 perTxCapUsd, uint256 dailyCapUsd, uint64 expiresAt) returns (uint256)",
    "function addPayee(uint256 mandateId, address payee, string qieName)",
    "function removePayee(uint256 mandateId, address payee)",
    "function fund(uint256 mandateId) payable",
    "function executePayment(uint256 mandateId, address payee, uint256 amountWei, uint256 intentId) returns (bool)",
    "function pauseMandate(uint256 mandateId)",
    "function resumeMandate(uint256 mandateId)",
    "function revokeMandate(uint256 mandateId)",
    "function withdrawUnspent(uint256 mandateId, uint256 amountWei)",
    "function getMandate(uint256 mandateId) view returns (address owner, address agent, uint256 perTxCapUsd, uint256 dailyCapUsd, uint64 expiresAt, uint8 status, uint256 balance)",
    "function isPayee(uint256 mandateId, address payee) view returns (bool)",
    "function payeeName(uint256 mandateId, address payee) view returns (string)",
    "function getPayees(uint256 mandateId) view returns (address[])",
    "function spentInWindow(uint256 mandateId) view returns (uint256)",
    "function mandateCount() view returns (uint256)",
    "function oracleAdapter() view returns (address)",
  ];
  var REGISTRY_ABI = [
    "function proposeIntent(bytes32 intentHash, bytes32 rationaleHash, uint256 mandateId, address payee, address token, uint256 amount) returns (uint256)",
    "function getIntent(uint256 intentId) view returns (tuple(bytes32 intentHash, bytes32 rationaleHash, uint256 mandateId, address payee, address token, uint256 amount, uint8 status, uint8 refusalReason, address proposedBy, uint64 createdAt))",
    "function intentCount() view returns (uint256)",
    "function refusalReasonCode(uint8 reason) view returns (string)",
  ];
  var ADAPTER_ABI = [
    "function isAvailable() view returns (bool)",
    "function usdValueOf(uint256 amountWei) view returns (uint256)",
  ];

  var MANDATE_STATUS = ["Active", "Paused", "Revoked"];
  var INTENT_STATUS = ["Proposed", "Executed", "Refused", "Expired"];

  function createClient(ethers, overrides) {
    var cfg = Object.assign({}, CONFIG, overrides || {});
    cfg.contracts = Object.assign({}, CONFIG.contracts, (overrides || {}).contracts || {});

    var usd = function (v) { return ethers.formatEther(v); }; // USD values are 18-decimal
    var qie = function (v) { return ethers.formatEther(v); };

    function vault(runner) {
      return new ethers.Contract(cfg.contracts.AgentVault, VAULT_ABI, runner);
    }
    function registry(runner) {
      return new ethers.Contract(cfg.contracts.PaymentIntentRegistry, REGISTRY_ABI, runner);
    }
    function readProvider() {
      return new ethers.JsonRpcProvider(cfg.rpcUrl);
    }
    function explorerTx(txHash) {
      return cfg.explorerUrl + "/tx/" + txHash;
    }
    function explorerAddress(address) {
      return cfg.explorerUrl + "/address/" + address;
    }

    async function assertTestnet(runner) {
      var provider = runner.provider || runner;
      var network = await provider.getNetwork();
      if (Number(network.chainId) !== cfg.chainId) {
        throw new Error(
          "refusing to write: expected QIE testnet chainId " + cfg.chainId + ", got " + network.chainId
        );
      }
    }

    // ------------------------------------------------------------ reads

    async function getOracleState(provider) {
      var v = vault(provider);
      var adapterAddr = await v.oracleAdapter();
      var adapter = new ethers.Contract(adapterAddr, ADAPTER_ABI, provider);
      var state = {
        adapter: adapterAddr,
        isRealAdapter:
          adapterAddr.toLowerCase() === cfg.contracts.OracleCapAdapter.toLowerCase(),
        available: false,
        qiePriceUsd: null,
      };
      try {
        state.available = await adapter.isAvailable();
        if (state.available) {
          state.qiePriceUsd = usd(await adapter.usdValueOf(ethers.parseEther("1")));
        }
      } catch (e) {
        state.available = false;
      }
      return state;
    }

    async function getMandate(provider, mandateId) {
      var v = vault(provider);
      var m = await v.getMandate(mandateId);
      var payeeAddrs = await v.getPayees(mandateId);
      var payees = [];
      for (var i = 0; i < payeeAddrs.length; i++) {
        payees.push({ address: payeeAddrs[i], qieName: await v.payeeName(mandateId, payeeAddrs[i]) });
      }
      var oracle = await getOracleState(provider);
      return {
        mandateId: Number(mandateId),
        owner: m.owner,
        agent: m.agent,
        status: MANDATE_STATUS[Number(m.status)],
        statusCode: Number(m.status),
        perTxCapUsd: usd(m.perTxCapUsd),
        dailyCapUsd: usd(m.dailyCapUsd),
        spentInWindowUsd: usd(await v.spentInWindow(mandateId)),
        balanceQie: qie(m.balance),
        expiresAt: Number(m.expiresAt),
        expiresAtIso: new Date(Number(m.expiresAt) * 1000).toISOString(),
        payees: payees,
        oracle: oracle,
      };
    }

    async function listMandates(provider) {
      var v = vault(provider);
      var count = Number(await v.mandateCount());
      var out = [];
      for (var id = 1; id <= count; id++) {
        out.push(await getMandate(provider, id));
      }
      return out;
    }

    async function mandatesOf(provider, owner) {
      var all = await listMandates(provider);
      var wanted = owner.toLowerCase();
      return all.filter(function (m) { return m.owner.toLowerCase() === wanted; });
    }

    var reasonCodeCache = {};
    async function refusalReasonCode(provider, reason) {
      var key = String(reason);
      if (!(key in reasonCodeCache)) {
        reasonCodeCache[key] = await registry(provider).refusalReasonCode(reason);
      }
      return reasonCodeCache[key];
    }

    async function getIntent(provider, intentId) {
      var r = registry(provider);
      var i = await r.getIntent(intentId);
      return {
        intentId: Number(intentId),
        mandateId: Number(i.mandateId),
        payee: i.payee,
        token: i.token,
        amountQie: qie(i.amount),
        status: INTENT_STATUS[Number(i.status)],
        statusCode: Number(i.status),
        refusalReasonCode:
          Number(i.status) === 2 ? await refusalReasonCode(provider, i.refusalReason) : null,
        proposedBy: i.proposedBy,
        createdAt: Number(i.createdAt),
        createdAtIso: new Date(Number(i.createdAt) * 1000).toISOString(),
      };
    }

    /// Newest first. `limit` rows, starting below `beforeId` (exclusive)
    /// when given — the intent log's paging hook.
    async function listIntents(provider, options) {
      var opts = options || {};
      var limit = opts.limit || 25;
      var r = registry(provider);
      var count = Number(await r.intentCount());
      var top = opts.beforeId ? Math.min(count, Number(opts.beforeId) - 1) : count;
      var out = [];
      for (var id = top; id >= 1 && out.length < limit; id--) {
        out.push(await getIntent(provider, id));
      }
      return { total: count, intents: out };
    }

    // ------------------------------------------------- payee resolution

    /// The agent layer resolves `.qie` names at registration time through
    /// the hosted QIE Wallet MCP and stores the name on-chain next to the
    /// address (DESIGN.md §4). The front end resolves the same way:
    ///   1. a raw address passes through (checksummed);
    ///   2. a `.qie` name already registered on this mandate resolves to
    ///      its stored address — the on-chain record the agent layer made;
    ///   3. any other `.qie` name is looked up via the MCP's
    ///      qie_resolve_name tool (mainnet-only per QIE's docs, so on
    ///      testnet this normally fails with an explanatory error).
    async function resolvePayee(provider, args) {
      var input = String(args.input || "").trim();
      if (ethers.isAddress(input)) {
        var address = ethers.getAddress(input);
        var qieName = "";
        try {
          if (await vault(provider).isPayee(args.mandateId, address)) {
            qieName = await vault(provider).payeeName(args.mandateId, address);
          }
        } catch (e) { /* name is display-only; absence is fine */ }
        return { address: address, qieName: qieName, via: "address" };
      }
      if (/\.qie$/i.test(input)) {
        var name = input.toLowerCase();
        var payeeAddrs = await vault(provider).getPayees(args.mandateId);
        for (var i = 0; i < payeeAddrs.length; i++) {
          var stored = await vault(provider).payeeName(args.mandateId, payeeAddrs[i]);
          if (stored && stored.toLowerCase() === name) {
            return { address: payeeAddrs[i], qieName: stored, via: "mandate-allowlist" };
          }
        }
        var resolved = await resolveNameViaMcp(name);
        if (resolved) return { address: resolved, qieName: input, via: "qie-wallet-mcp" };
        throw new Error(
          '"' + input + '" is not registered on mandate #' + args.mandateId +
          " and the QIE Wallet MCP could not resolve it (QIE ID lookups are mainnet-only). " +
          "On testnet, register the payee's address first — the name is stored with it."
        );
      }
      throw new Error('"' + input + '" is neither an address nor a .qie name.');
    }

    async function resolveNameViaMcp(name) {
      // Best-effort Streamable-HTTP MCP call (initialize, then tools/call).
      // Any transport/shape problem returns null — the caller turns that
      // into the explanatory error above.
      try {
        var headers = {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        };
        var init = await fetch(cfg.mcpUrl, {
          method: "POST",
          headers: headers,
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "agentpay-guard-frontend", version: "0.4.0" },
            },
          }),
        });
        var sessionId = init.headers.get("mcp-session-id");
        if (sessionId) headers["mcp-session-id"] = sessionId;
        await init.text();
        var res = await fetch(cfg.mcpUrl, {
          method: "POST",
          headers: headers,
          body: JSON.stringify({
            jsonrpc: "2.0", id: 2, method: "tools/call",
            params: { name: "qie_resolve_name", arguments: { name: name } },
          }),
        });
        var text = await res.text();
        var match = text.match(/0x[0-9a-fA-F]{40}/);
        return match ? ethers.getAddress(match[0]) : null;
      } catch (e) {
        return null;
      }
    }

    // ---------------------------------------------------- policy engine

    /// Deterministic policy engine (DESIGN.md §4) — a faithful port of the
    /// agent library's policyCheck: same checks, same order as
    /// AgentVault._evaluate, same refusal codes. Predicts the verdict
    /// before anything is signed; it never overrides the chain.
    async function policyCheck(provider, args) {
      var v = vault(provider);
      var amountWei = ethers.parseEther(String(args.amountQie));
      var m = await v.getMandate(args.mandateId);
      var now = (await provider.getBlock("latest")).timestamp;
      var checks = {};
      function refuse(code) {
        return { ok: false, predictedRefusal: code, checks: checks };
      }

      checks.mandateStatus = MANDATE_STATUS[Number(m.status)];
      if (Number(m.status) === 2) return refuse("MANDATE_REVOKED");
      if (Number(m.status) === 1) return refuse("MANDATE_PAUSED");
      checks.expired = now >= Number(m.expiresAt);
      if (checks.expired) return refuse("MANDATE_EXPIRED");

      checks.payeeAllowed = await v.isPayee(args.mandateId, args.payee);
      if (!checks.payeeAllowed) return refuse("PAYEE_NOT_ALLOWED");

      var adapter = new ethers.Contract(await v.oracleAdapter(), ADAPTER_ABI, provider);
      var usdValue;
      try {
        checks.oracleAvailable = await adapter.isAvailable();
        if (!checks.oracleAvailable) return refuse("ORACLE_UNAVAILABLE");
        usdValue = await adapter.usdValueOf(amountWei);
      } catch (e) {
        checks.oracleAvailable = false;
        return refuse("ORACLE_UNAVAILABLE");
      }
      checks.usdValue = usd(usdValue);
      checks.perTxCapOk = usdValue <= m.perTxCapUsd;
      if (!checks.perTxCapOk) return refuse("OVER_TX_CAP");
      var spent = await v.spentInWindow(args.mandateId);
      checks.dailyCapOk = spent + usdValue <= m.dailyCapUsd;
      if (!checks.dailyCapOk) return refuse("OVER_DAILY_CAP");
      checks.balanceOk = amountWei <= m.balance;
      if (!checks.balanceOk) return refuse("INSUFFICIENT_BALANCE");
      return { ok: true, predictedRefusal: null, usdValue: usd(usdValue), checks: checks };
    }

    // ------------------------------------------------------------ writes

    async function createMandate(signer, args) {
      await assertTestnet(signer);
      var now = (await signer.provider.getBlock("latest")).timestamp;
      var tx = await vault(signer).createMandate(
        args.agent,
        ethers.parseEther(String(args.perTxCapUsd)),
        ethers.parseEther(String(args.dailyCapUsd)),
        now + Math.floor(Number(args.expiryDays) * 24 * 3600)
      );
      var receipt = await tx.wait();
      return { mandateId: Number(await vault(signer).mandateCount()), txHash: receipt.hash };
    }

    async function addPayee(signer, args) {
      await assertTestnet(signer);
      var tx = await vault(signer).addPayee(args.mandateId, args.payee, args.qieName || "");
      var receipt = await tx.wait();
      return { mandateId: Number(args.mandateId), payee: args.payee, qieName: args.qieName || "", txHash: receipt.hash };
    }

    async function removePayee(signer, args) {
      await assertTestnet(signer);
      var tx = await vault(signer).removePayee(args.mandateId, args.payee);
      var receipt = await tx.wait();
      return { mandateId: Number(args.mandateId), payee: args.payee, txHash: receipt.hash };
    }

    async function fundMandate(signer, args) {
      await assertTestnet(signer);
      var tx = await vault(signer).fund(args.mandateId, {
        value: ethers.parseEther(String(args.amountQie)),
      });
      var receipt = await tx.wait();
      return { mandateId: Number(args.mandateId), fundedQie: String(args.amountQie), txHash: receipt.hash };
    }

    async function pauseMandate(signer, args) {
      await assertTestnet(signer);
      var tx = await vault(signer).pauseMandate(args.mandateId);
      var receipt = await tx.wait();
      return { mandateId: Number(args.mandateId), txHash: receipt.hash };
    }

    async function resumeMandate(signer, args) {
      await assertTestnet(signer);
      var tx = await vault(signer).resumeMandate(args.mandateId);
      var receipt = await tx.wait();
      return { mandateId: Number(args.mandateId), txHash: receipt.hash };
    }

    async function revokeMandate(signer, args) {
      await assertTestnet(signer);
      var tx = await vault(signer).revokeMandate(args.mandateId);
      var receipt = await tx.wait();
      return { mandateId: Number(args.mandateId), txHash: receipt.hash };
    }

    async function proposePayment(signer, args) {
      await assertTestnet(signer);
      var amountWei = ethers.parseEther(String(args.amountQie));
      var ref = args.reference || "payment-" + Date.now();
      var intentHash = ethers.keccak256(ethers.toUtf8Bytes("agentpay:" + ref));
      var rationaleHash = ethers.keccak256(ethers.toUtf8Bytes(args.rationale || ""));
      var tx = await registry(signer).proposeIntent(
        intentHash,
        rationaleHash,
        args.mandateId,
        args.payee,
        ethers.ZeroAddress,
        amountWei
      );
      var receipt = await tx.wait();
      var intentId = await registry(signer).intentCount();
      return {
        intentId: Number(intentId),
        txHash: receipt.hash,
        reference: ref,
        rationale: args.rationale || "",
        amountQie: String(args.amountQie),
        payee: args.payee,
      };
    }

    async function executePayment(signer, args) {
      await assertTestnet(signer);
      var provider = signer.provider;
      var policy = await policyCheck(provider, {
        mandateId: args.mandateId, payee: args.payee, amountQie: args.amountQie,
      });
      var amountWei = ethers.parseEther(String(args.amountQie));
      var tx = await vault(signer).executePayment(args.mandateId, args.payee, amountWei, args.intentId);
      var receipt = await tx.wait();
      var intent = await getIntent(provider, args.intentId);
      return {
        intentId: Number(args.intentId),
        txHash: receipt.hash,
        txStatus: receipt.status === 1 ? "mined" : "failed",
        executed: intent.status === "Executed",
        intentStatus: intent.status,
        refusalReasonCode: intent.refusalReasonCode,
        policyPrediction: policy.ok ? "ok" : policy.predictedRefusal,
        policyMatchedChain:
          (policy.ok && intent.status === "Executed") ||
          policy.predictedRefusal === intent.refusalReasonCode,
      };
    }

    /// The full payment flow the UI runs: record the intent, then ask the
    /// vault to execute. Out-of-mandate attempts are refused on-chain and
    /// the refusal (with reason code) is read back as proof.
    async function pay(signer, args) {
      var proposed = await proposePayment(signer, args);
      var executed = await executePayment(signer, {
        mandateId: args.mandateId,
        payee: args.payee,
        amountQie: args.amountQie,
        intentId: proposed.intentId,
      });
      return {
        intentId: proposed.intentId,
        reference: proposed.reference,
        proposeTxHash: proposed.txHash,
        executeTxHash: executed.txHash,
        txStatus: executed.txStatus,
        executed: executed.executed,
        intentStatus: executed.intentStatus,
        refusalReasonCode: executed.refusalReasonCode,
        policyPrediction: executed.policyPrediction,
        policyMatchedChain: executed.policyMatchedChain,
      };
    }

    return {
      config: cfg,
      MANDATE_STATUS: MANDATE_STATUS,
      INTENT_STATUS: INTENT_STATUS,
      readProvider: readProvider,
      explorerTx: explorerTx,
      explorerAddress: explorerAddress,
      getOracleState: getOracleState,
      getMandate: getMandate,
      listMandates: listMandates,
      mandatesOf: mandatesOf,
      getIntent: getIntent,
      listIntents: listIntents,
      resolvePayee: resolvePayee,
      policyCheck: policyCheck,
      createMandate: createMandate,
      addPayee: addPayee,
      removePayee: removePayee,
      fundMandate: fundMandate,
      pauseMandate: pauseMandate,
      resumeMandate: resumeMandate,
      revokeMandate: revokeMandate,
      proposePayment: proposePayment,
      executePayment: executePayment,
      pay: pay,
    };
  }

  var api = { CONFIG: CONFIG, createClient: createClient };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.AgentPay = api;
})(typeof window !== "undefined" ? window : globalThis);
