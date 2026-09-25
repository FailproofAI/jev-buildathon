#!/usr/bin/env node
// MCP server "itsm": the Northwind Labs service desk, for the Helix agent.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../../env/mcp.mjs";
import { tools } from "./tools.mjs";
import { createWorld, NOW } from "./world.mjs";

serve({
  name: "itsm",
  version: "1.0.0",
  agentDir: dirname(fileURLToPath(import.meta.url)),
  createWorld,
  tools,
  instructions: `Northwind Labs service desk tools. The current time is ${NOW}.`,
});
