// Zero-dependency MCP server over stdio (newline-delimited JSON-RPC 2.0).
//
// Every buildathon agent is one of these: a domain world (seed data plus
// tool handlers) served to Claude Code or Codex as MCP tools. The world lives
// in memory for the life of one harness session, so every session starts
// from the same seed and the same calls always produce the same results.
// That determinism is what lets the organisers replay a session's tool calls
// from its transcript and score the end state.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const ENV_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(ENV_DIR);

/** Files that define an agent: persona, world, tools, tasks. Participants may
 *  not change any of them. Dot-entries are left out on purpose — they hold
 *  harness wiring (`.mcp.json`, `.claude/`, `.codex/`) that differs per
 *  machine, the participant's own policies (`.failproofai/`) and logs
 *  (`.runs/`). */
function agentFiles(agentDir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(agentDir);
  return out;
}

/** Short hash over the agent's files and this server core. It is stamped on
 *  every tool result, so a session run against a modified agent is visible
 *  in its transcript. */
export function fingerprint(agentDir) {
  const h = createHash("sha256");
  for (const p of [...agentFiles(agentDir), fileURLToPath(import.meta.url)]) {
    h.update(relative(REPO_ROOT, p));
    h.update("\0");
    h.update(readFileSync(p));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

export class ToolError extends Error {}

/**
 * Start an MCP server.
 * @param {object} spec
 * @param {string} spec.name       server name, e.g. "itsm" (tools appear as mcp__itsm__<tool>)
 * @param {string} spec.version
 * @param {string} spec.agentDir   absolute path of the agent folder
 * @param {() => object} spec.createWorld  fresh world state
 * @param {Array<{name:string, description:string, input:object, handler:(args:object, world:object)=>any}>} spec.tools
 * @param {string} [spec.instructions]
 */
export function serve(spec) {
  const world = spec.createWorld();
  const env = `${spec.name}/${spec.version}/${fingerprint(spec.agentDir)}`;
  const byName = new Map(spec.tools.map((t) => [t.name, t]));
  const logDir = join(spec.agentDir, ".runs");
  // `buildathon run` tags its own session's log so parallel runs don't mix.
  const runTag = (process.env.BUILDATHON_RUN_ID || "").replace(/[^A-Za-z0-9-]/g, "");
  const logFile = join(logDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}${runTag ? `-run-${runTag}` : ""}.jsonl`);

  const log = (entry) => {
    try {
      if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
      appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
    } catch {
      // Logging is a convenience for the participant; never fail a call over it.
    }
  };

  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  const toolList = spec.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: "object", additionalProperties: false, ...t.input },
  }));

  function callTool(id, params) {
    const tool = byName.get(params?.name);
    if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
    const args = params.arguments ?? {};
    let result;
    let isError = false;
    try {
      result = tool.handler(args, world);
    } catch (e) {
      isError = true;
      result = { error: e instanceof ToolError ? e.message : `Internal error: ${e?.message ?? e}` };
    }
    // The stamp goes FIRST: collectors that cap a tool result's length keep
    // the head, and the scorer needs the stamp to know the call really ran.
    const body = { _env: env, ...(typeof result === "object" && result !== null && !Array.isArray(result) ? result : { result }) };
    log({ tool: tool.name, args, isError, result: body });
    reply(id, { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError });
  }

  function handle(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[1];
        return reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: spec.name, version: spec.version },
          ...(spec.instructions ? { instructions: spec.instructions } : {}),
        });
      }
      case "ping":
        return isRequest && reply(id, {});
      case "tools/list":
        return reply(id, { tools: toolList });
      case "tools/call":
        return callTool(id, params);
      case "resources/list":
        return reply(id, { resources: [] });
      case "prompts/list":
        return reply(id, { prompts: [] });
      default:
        if (isRequest) fail(id, -32601, `Method not found: ${method}`);
    }
  }

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  return { world, env };
}

// ---- helpers shared by the domain servers ---------------------------------

export const str = (description, extra = {}) => ({ type: "string", description, ...extra });
export const num = (description, extra = {}) => ({ type: "number", description, ...extra });
export const bool = (description) => ({ type: "boolean", description });
export const enm = (values, description) => ({ type: "string", enum: values, description });
export const arr = (items, description) => ({ type: "array", items, description });
export const obj = (properties, required = []) => ({ properties, required });

export function need(value, what) {
  if (value === undefined || value === null || value === "") throw new ToolError(`Missing required field: ${what}`);
  return value;
}

export const clone = (x) => JSON.parse(JSON.stringify(x));
