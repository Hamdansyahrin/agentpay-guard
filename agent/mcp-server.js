#!/usr/bin/env node
// AgentPay Guard — MCP-style tool server (Stage 3).
//
// Speaks the Model Context Protocol's JSON-RPC 2.0 over stdio
// (newline-delimited messages): initialize, tools/list, tools/call, ping.
// Any MCP client can connect an AI agent to the AgentPay Guard mandate
// tools in agent/lib.js, e.g.:
//
//   { "mcpServers": { "agentpay-guard": {
//       "command": "node", "args": ["agent/mcp-server.js"] } } }
//
// Scope note: this server exposes OUR contracts' state and actions. The
// hosted read-only QIE Wallet MCP (https://mcp.qie.digital/mcp) stays the
// agent's general read layer for balances, token lists, .qie resolution
// and tx status (DESIGN.md §4) — the two are complementary.
// Testnet only: lib.js refuses any chain other than 1983.
const readline = require("readline");
const { connect, TOOLS } = require("./lib");

const SERVER_INFO = { name: "agentpay-guard", version: "0.3.0" };
const PROTOCOL_VERSION = "2024-11-05";

let ctxPromise = null;
function ctx() {
  if (!ctxPromise) ctxPromise = connect();
  return ctxPromise;
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return; // notifications need no reply
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const tool = TOOLS[params && params.name];
      if (!tool) return error(id, -32602, `unknown tool: ${params && params.name}`);
      try {
        const out = await tool.run(await ctx(), params.arguments || {});
        return result(id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          isError: false,
        });
      } catch (e) {
        return result(id, {
          content: [{ type: "text", text: `Error: ${e.shortMessage || e.message}` }],
          isError: true,
        });
      }
    }
    default:
      if (!isNotification) return error(id, -32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore unparseable lines rather than dying
  }
  handle(msg).catch((e) => {
    if (msg && msg.id !== undefined) error(msg.id, -32603, e.message);
  });
});
