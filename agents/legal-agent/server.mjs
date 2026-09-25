#!/usr/bin/env node
// MCP server "legal": Northwind Labs in-house legal operations, for the Lex agent.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../../env/mcp.mjs";
import { tools } from "./tools.mjs";
import { createWorld, NOW } from "./world.mjs";

serve({
  name: "legal",
  version: "1.0.0",
  agentDir: dirname(fileURLToPath(import.meta.url)),
  createWorld,
  tools,
  instructions: `Northwind Labs legal operations tools. The current time is ${NOW}.`,
});
