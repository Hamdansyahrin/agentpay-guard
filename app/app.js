// AgentPay Guard front end — UI glue (Stage 4).
//
// All chain interaction goes through agentpay.js (window.AgentPay); this
// file only renders state and forwards user actions. Wallet writes use
// the connected account's signer; every read works with no wallet at all
// through the public testnet RPC.
(function () {
  "use strict";
  var ethers = window.ethers;
  var client = window.AgentPay.createClient(ethers);
  var cfg = client.config;

  var state = {
    account: null,
    injected: null,        // raw EIP-1193 provider from the wallet
    walletProvider: null,  // ethers BrowserProvider over `injected`
    signer: null,          // set only when connected AND on chain 1983
    chainOk: false,
    mandates: [],
    selectedId: null,
    sessionIntents: {},    // intentId -> { proposeTxHash, executeTxHash }
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function shortAddr(a) { return a ? a.slice(0, 6) + "…" + a.slice(-4) : ""; }
  function readProvider() {
    return state.chainOk && state.walletProvider ? state.walletProvider : client.readProvider();
  }
  function txLink(txHash, label) {
    return '<a href="' + client.explorerTx(txHash) + '" target="_blank" rel="noopener">' +
      esc(label || txHash) + "</a>";
  }
  function addrLink(address, label) {
    return '<a class="mono" href="' + client.explorerAddress(address) +
      '" target="_blank" rel="noopener">' + esc(label || address) + "</a>";
  }

  // ---------------------------------------------------------------

  // Footer contract links (static wiring, works with no wallet).
  $("foot-vault").href = client.explorerAddress(cfg.contracts.AgentVault);
  $("foot-vault").textContent = "AgentVault " + cfg.contracts.AgentVault;
  $("foot-registry").href = client.explorerAddress(cfg.contracts.PaymentIntentRegistry);
  $("foot-registry").textContent = "PaymentIntentRegistry " + cfg.contracts.PaymentIntentRegistry;
  $("foot-adapter").href = client.explorerAddress(cfg.contracts.OracleCapAdapter);
  $("foot-adapter").textContent = "OracleCapAdapter " + cfg.contracts.OracleCapAdapter;

  // ------------------------------------------------------- wallet setup

  var discovered = {}; // EIP-6963 announcements, rdns -> detail
  window.addEventListener("eip6963:announceProvider", function (ev) {
    discovered[ev.detail.info.rdns] = ev.detail;
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  function injectedProvider() {
    if (discovered["me.qiewallet"]) return discovered["me.qiewallet"].provider;
    if (window.ethereum && window.ethereum.request) return window.ethereum;
    if (window.qie && window.qie.request) return window.qie;
    var keys = Object.keys(discovered);
    return keys.length ? discovered[keys[0]].provider : null;
  }

  async function connectWallet() {
    var injected = injectedProvider();
    if (!injected) {
      $("nowallet-banner").hidden = false;
      return;
    }
    state.injected = injected;
    var accounts = await injected.request({ method: "eth_requestAccounts" });
    if (!accounts || !accounts.length) return;
    state.account = ethers.getAddress(accounts[0]);
    state.walletProvider = new ethers.BrowserProvider(injected);
    await refreshChainState();

    injected.on && injected.on("accountsChanged", function () { connectWallet(); });
    injected.on && injected.on("chainChanged", function () { window.location.reload(); });
  }

  async function refreshChainState() {
    if (!state.walletProvider) return;
    var network = await state.walletProvider.getNetwork();
    state.chainOk = Number(network.chainId) === cfg.chainId;
    state.signer = state.chainOk ? await state.walletProvider.getSigner() : null;

    var pill = $("network-pill");
    pill.textContent = state.chainOk
      ? "QIE Testnet · 1983"
      : "Wrong network · chain " + Number(network.chainId);
    pill.className = "pill " + (state.chainOk ? "pill-ok" : "pill-warn");
    $("network-banner").hidden = state.chainOk;
    $("mode-label").textContent = state.chainOk ? "connected — you can sign" : "wrong network — read-only";

    var chip = $("account-chip");
    chip.hidden = false;
    chip.textContent = shortAddr(state.account);
    chip.title = state.account;
    $("connect-btn").textContent = "Connected";
    var agentInput = $("c-agent");
    if (agentInput && !agentInput.value) agentInput.value = state.account;
    await loadMandates();
  }

  async function switchNetwork() {
    if (!state.injected) return;
    var params = {
      chainId: cfg.chainIdHex,
      chainName: "QIE Testnet",
      nativeCurrency: { name: "QIE", symbol: "QIE", decimals: 18 },
      rpcUrls: [cfg.rpcUrl],
      blockExplorerUrls: [cfg.explorerUrl],
    };
    try {
      await state.injected.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: cfg.chainIdHex }],
      });
    } catch (e) {
      if (e && e.code === 4902) {
        try {
          await state.injected.request({ method: "wallet_addEthereumChain", params: [params] });
        } catch (e2) {
          $("network-banner-text").textContent =
            "The wallet refused to add QIE Testnet. In QIE Wallet, enable the testnet toggle in settings first (testnet is hidden until then), then try again.";
          return;
        }
      } else if (e && e.code === 4001) {
        return; // user rejected — nothing to explain
      } else {
        $("network-banner-text").textContent =
          "Switch failed (" + esc(e && e.message ? e.message : e) + "). In QIE Wallet, enable the testnet toggle in settings first, then try again.";
        return;
      }
    }
    await refreshChainState();
  }

  // ---------------------------------------------------------- oracle strip

  async function loadOracle() {
    try {
      var o = await client.getOracleState(readProvider());
      $("oracle-adapter").innerHTML = addrLink(o.adapter, shortAddr(o.adapter)) +
        (o.isRealAdapter ? " (real QIE Oracle adapter)" : " (testnet mock adapter)");
      $("oracle-status").textContent = o.available
        ? "available"
        : "unavailable — payments fail closed (ORACLE_UNAVAILABLE)";
      $("oracle-price").textContent = o.qiePriceUsd ? "$" + o.qiePriceUsd + " / QIE" : "—";
    } catch (e) {
      $("oracle-status").textContent = "could not read the adapter (" + (e.message || e) + ")";
    }
  }

  // -------------------------------------------------------------- mandates

  function fmtUsd(v) { return "$" + Number(v).toFixed(2); }
  function fmtWhen(ts) {
    var d = new Date(ts * 1000);
    var now = Date.now() / 1000;
    var rel;
    if (ts <= now) rel = "expired";
    else {
      var s = ts - now;
      var days = Math.floor(s / 86400);
      var hrs = Math.floor((s % 86400) / 3600);
      rel = "in " + (days > 0 ? days + "d " : "") + hrs + "h";
    }
    return d.toLocaleString() + " (" + rel + ")";
  }
  function statusBadge(status) {
    return '<span class="badge badge-' + status.toLowerCase() + '">' + esc(status) + "</span>";
  }

  async function loadMandates() {
    var provider = readProvider();
    try {
      var all = await client.listMandates(provider);
      var mine = state.account
        ? all.filter(function (m) { return m.owner.toLowerCase() === state.account.toLowerCase(); })
        : [];
      if (state.account && mine.length) {
        state.mandates = mine;
        $("mandate-scope").textContent = "your mandates";
      } else {
        state.mandates = all;
        $("mandate-scope").textContent = state.account
          ? "you own no mandates yet — showing all on testnet"
          : "all mandates on testnet (read-only)";
      }
      var sel = $("mandate-select");
      var keep = state.selectedId;
      sel.innerHTML = "";
      state.mandates.forEach(function (m) {
        var opt = document.createElement("option");
        opt.value = m.mandateId;
        opt.textContent = "#" + m.mandateId + " — " + m.status + " — " + m.balanceQie + " QIE funded";
        sel.appendChild(opt);
      });
      if (keep && state.mandates.some(function (m) { return m.mandateId === keep; })) {
        sel.value = keep;
      }
      state.selectedId = sel.value ? Number(sel.value) : null;
      renderMandate();
    } catch (e) {
      $("mandate-empty").hidden = false;
      $("mandate-empty").textContent = "Could not load mandates: " + (e.message || e);
    }
  }

  function selectedMandate() {
    return state.mandates.find(function (m) { return m.mandateId === state.selectedId; }) || null;
  }

  function renderMandate() {
    var m = selectedMandate();
    var empty = $("mandate-empty");
    if (!m) {
      empty.hidden = false;
      empty.textContent = "No mandates exist on this deployment yet — create the first one.";
      $("mandate-kv").hidden = true;
      $("m-payees-wrap").hidden = true;
      $("owner-actions").hidden = true;
      return;
    }
    empty.hidden = true;
    $("mandate-kv").hidden = false;
    $("m-status").innerHTML = statusBadge(m.status);
    $("m-owner").innerHTML = addrLink(m.owner);
    $("m-agent").innerHTML = addrLink(m.agent);
    $("m-txcap").textContent = fmtUsd(m.perTxCapUsd) + " per payment";
    $("m-dailycap").textContent = fmtUsd(m.dailyCapUsd) + " per rolling 24h";
    $("m-spent").textContent = fmtUsd(m.spentInWindowUsd);
    $("m-balance").textContent = m.balanceQie + " QIE";
    $("m-expiry").textContent = fmtWhen(m.expiresAt);

    var list = $("m-payees");
    list.innerHTML = "";
    if (!m.payees.length) {
      list.innerHTML = '<li class="hint">No payees yet — the agent cannot pay anyone under this mandate.</li>';
    }
    m.payees.forEach(function (p) {
      var li = document.createElement("li");
      li.innerHTML =
        (p.qieName ? '<span class="payee-name">' + esc(p.qieName) + "</span>" : "<span></span>") +
        addrLink(p.address);
      list.appendChild(li);
    });
    $("m-payees-wrap").hidden = false;

    var isOwner = state.account && m.owner.toLowerCase() === state.account.toLowerCase();
    $("owner-actions").hidden = !(isOwner && state.chainOk);
    $("pause-btn").disabled = m.status !== "Active";
    $("resume-btn").disabled = m.status !== "Paused";
    $("revoke-btn").disabled = m.status === "Revoked";
    $("revoke-btn").textContent = "Revoke mandate";
  }

  // ------------------------------------------------------- owner actions

  async function runAction(resultEl, busyLabel, fn) {
    var el = $(resultEl);
    el.innerHTML = esc(busyLabel || "Waiting for the wallet signature…");
    try {
      var out = await fn();
      el.innerHTML = "Done — tx " + txLink(out.txHash, shortAddr(out.txHash));
      await loadMandates();
      await loadOracle();
      return out;
    } catch (e) {
      el.innerHTML = "Failed: " + esc(e.shortMessage || e.message || String(e));
      return null;
    }
  }

  function needSigner() {
    if (!state.signer) {
      window.alert("Connect a wallet on QIE Testnet (1983) first.");
      return false;
    }
    return true;
  }

  $("fund-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!needSigner()) return;
    var amount = $("fund-amount").value.trim();
    runAction("mandate-action-result", "Funding…", function () {
      return client.fundMandate(state.signer, { mandateId: state.selectedId, amountQie: amount });
    });
  });

  $("addpayee-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!needSigner()) return;
    var input = $("addpayee-address").value.trim();
    var name = $("addpayee-name").value.trim();
    (async function () {
      var payee = input;
      if (!ethers.isAddress(input)) {
        try {
          var resolved = await client.resolvePayee(readProvider(), { mandateId: state.selectedId, input: input });
          payee = resolved.address;
          if (!name) name = resolved.qieName;
        } catch (e) {
          $("mandate-action-result").textContent = "Could not resolve payee: " + (e.message || e);
          return;
        }
      }
      await runAction("mandate-action-result", "Adding payee…", function () {
        return client.addPayee(state.signer, { mandateId: state.selectedId, payee: payee, qieName: name });
      });
    })();
  });

  $("pause-btn").addEventListener("click", function () {
    if (!needSigner()) return;
    runAction("mandate-action-result", "Pausing…", function () {
      return client.pauseMandate(state.signer, { mandateId: state.selectedId });
    });
  });

  $("resume-btn").addEventListener("click", function () {
    if (!needSigner()) return;
    runAction("mandate-action-result", "Resuming…", function () {
      return client.resumeMandate(state.signer, { mandateId: state.selectedId });
    });
  });

  $("revoke-btn").addEventListener("click", function () {
    if (!needSigner()) return;
    var btn = $("revoke-btn");
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = "Click again to confirm revoke";
      setTimeout(function () { btn.dataset.armed = ""; btn.textContent = "Revoke mandate"; }, 6000);
      return;
    }
    btn.dataset.armed = "";
    runAction("mandate-action-result", "Revoking…", function () {
      return client.revokeMandate(state.signer, { mandateId: state.selectedId });
    });
  });

  // --------------------------------------------------------------- create

  $("create-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!needSigner()) return;
    var agent = $("c-agent").value.trim() || state.account;
    var payeeInput = $("c-payee").value.trim();
    var payeeName = $("c-payeename").value.trim();
    (async function () {
      var created = await runAction("create-result", "Creating the mandate…", function () {
        return client.createMandate(state.signer, {
          agent: agent,
          perTxCapUsd: $("c-txcap").value.trim(),
          dailyCapUsd: $("c-dailycap").value.trim(),
          expiryDays: Number($("c-expiry").value),
        });
      });
      if (!created) return;
      state.selectedId = created.mandateId;
      await loadMandates();
      if (payeeInput) {
        var payee = payeeInput;
        if (!ethers.isAddress(payeeInput)) {
          try {
            var resolved = await client.resolvePayee(readProvider(), { mandateId: created.mandateId, input: payeeInput });
            payee = resolved.address;
            if (!payeeName) payeeName = resolved.qieName;
          } catch (e) {
            $("create-result").innerHTML +=
              "<br>Mandate #" + created.mandateId + " created, but the first payee was skipped: " + esc(e.message || e);
            return;
          }
        }
        await runAction("create-result", "Mandate created — adding the first payee…", function () {
          return client.addPayee(state.signer, { mandateId: created.mandateId, payee: payee, qieName: payeeName });
        });
        state.selectedId = created.mandateId;
        await loadMandates();
      }
    })();
  });

  // ---------------------------------------------------------------- boot

  $("connect-btn").addEventListener("click", function () {
    connectWallet().catch(function (e) {
      $("nowallet-banner").hidden = false;
      $("nowallet-banner").innerHTML = "<strong>Connect failed.</strong> " + esc(e.message || String(e));
    });
  });
  $("switch-network-btn").addEventListener("click", switchNetwork);
  $("mandate-select").addEventListener("change", function () {
    state.selectedId = Number(this.value);
    renderMandate();
  });
  $("refresh-mandates-btn").addEventListener("click", function () {
    loadMandates();
    loadOracle();
  });

  if (!injectedProvider()) $("nowallet-banner").hidden = false;
  loadOracle();
  loadMandates();
})();
