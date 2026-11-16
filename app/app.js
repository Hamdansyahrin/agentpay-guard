// AgentPay Guard front end — UI glue (Stage 4).
//
// All chain interaction goes through agentpay.js (window.AgentPay); this
// file only renders state and forwards user actions. It is built up in
// stages: wallet connect + mandates first, then the payment flow, then
// the intent log.
(function () {
  "use strict";
  var client = window.AgentPay.createClient(window.ethers);
  var cfg = client.config;

  function $(id) { return document.getElementById(id); }

  // Footer contract links (static wiring, works with no wallet).
  $("foot-vault").href = client.explorerAddress(cfg.contracts.AgentVault);
  $("foot-vault").textContent = "AgentVault " + cfg.contracts.AgentVault;
  $("foot-registry").href = client.explorerAddress(cfg.contracts.PaymentIntentRegistry);
  $("foot-registry").textContent = "PaymentIntentRegistry " + cfg.contracts.PaymentIntentRegistry;
  $("foot-adapter").href = client.explorerAddress(cfg.contracts.OracleCapAdapter);
  $("foot-adapter").textContent = "OracleCapAdapter " + cfg.contracts.OracleCapAdapter;
})();
