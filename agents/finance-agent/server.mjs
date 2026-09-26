#!/usr/bin/env node
// MCP server "finance": Northwind Labs accounts payable and treasury, for the Ledger agent.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../../env/mcp.mjs";
import { tools } from "./tools.mjs";
import { createWorld, NOW } from "./world.mjs";

serve({
  name: "finance",
  version: "1.0.0",
  agentDir: dirname(fileURLToPath(import.meta.url)),
  createWorld,
  tools,
  instructions: `Northwind Labs finance-operations tools (simulated AP, treasury and ledger). The current time is ${NOW}.`,
});
