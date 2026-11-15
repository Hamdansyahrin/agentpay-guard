#!/usr/bin/env node
// AgentPay Guard — agent CLI (Stage 3). Thin front end over agent/lib.js;
// the same tools are exposed over MCP by agent/mcp-server.js.
//
//   node agent/cli.js tools
//   node agent/cli.js get-mandate <mandateId>
//   node agent/cli.js policy-check <mandateId> <payee> <amountQie>
//   node agent/cli.js propose <mandateId> <payee> <amountQie> <rationale...>
//   node agent/cli.js execute <mandateId> <payee> <amountQie> <intentId>
//   node agent/cli.js get-intent <intentId>
//
// Testnet only (chainId 1983) — lib.js enforces it.
const { connect, TOOLS } = require("./lib");

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "tools" || !cmd) {
    for (const [name, t] of Object.entries(TOOLS)) {
      console.log(`${name}\n  ${t.description}\n`);
    }
    return;
  }

  const ctx = await connect();
  let out;
  switch (cmd) {
    case "get-mandate":
      out = await TOOLS.get_mandate.run(ctx, { mandateId: Number(rest[0]) });
      break;
    case "policy-check":
      out = await TOOLS.policy_check.run(ctx, { mandateId: Number(rest[0]), payee: rest[1], amountQie: rest[2] });
      break;
    case "propose":
      out = await TOOLS.propose_payment.run(ctx, {
        mandateId: Number(rest[0]),
        payee: rest[1],
        amountQie: rest[2],
        rationale: rest.slice(3).join(" "),
        reference: `cli-${Date.now()}`,
      });
      break;
    case "execute":
      out = await TOOLS.execute_payment.run(ctx, {
        mandateId: Number(rest[0]),
        payee: rest[1],
        amountQie: rest[2],
        intentId: Number(rest[3]),
      });
      break;
    case "get-intent":
      out = await TOOLS.get_intent.run(ctx, { intentId: Number(rest[0]) });
      break;
    default:
      console.error(`unknown command: ${cmd} (try: tools)`);
      process.exitCode = 2;
      return;
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exitCode = 1;
});
