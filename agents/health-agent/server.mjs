#!/usr/bin/env node
// MCP server "health": Northwind Health Clinic operations, for the Care agent.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../../env/mcp.mjs";
import { tools } from "./tools.mjs";
import { createWorld, NOW } from "./world.mjs";

serve({
  name: "health",
  version: "1.0.0",
  agentDir: dirname(fileURLToPath(import.meta.url)),
  createWorld,
  tools,
  instructions: `Northwind Health Clinic operations tools (simulated EHR). The current time is ${NOW}.`,
});
