// policykit — helpers for writing buildathon policies.
//
// Import it from a policy file in an agent's `.failproofai/policies/`:
//
//   import { customPolicies, allow, deny, instruct } from "failproofai";
//   import { mcpCall, history, userPrompts, askJev } from "../../../../policykit/index.mjs";
//
// Everything here works the same under Claude Code and Codex.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- the tool call being decided -------------------------------------------

/** `{ server, tool, args }` when the call is an MCP tool (e.g. mcp__itsm__close_ticket), else null. */
export function mcpCall(ctx) {
  const m = /^mcp__(.+?)__(.+)$/.exec(ctx?.toolName ?? "");
  if (!m) return null;
  return { server: m[1], tool: m[2], args: ctx.toolInput ?? {} };
}

// ---- what happened earlier in the session ------------------------------------

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

function readLines(path) {
  if (!path || !existsSync(path)) return [];
  const st = statSync(path);
  let text = readFileSync(path, "utf8");
  if (st.size > MAX_TRANSCRIPT_BYTES) text = text.slice(-MAX_TRANSCRIPT_BYTES);
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a partially written last line
    }
  }
  return out;
}

const textOf = (c) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("\n") : c && typeof c === "object" ? textOf(c.content ?? c.text ?? "") : "";

const parseJson = (s) => {
  if (typeof s !== "string") return s ?? null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/**
 * Every tool call made so far in this session, oldest first:
 * `[{ tool, server, args, result }]`. `server`/`tool` are split for MCP tools;
 * `result` is the parsed JSON the tool returned (or its text, or null if the
 * call was blocked or has not returned).
 */
export function history(ctx) {
  const rows = readLines(ctx?.session?.transcriptPath ?? ctx?.payload?.transcript_path);
  const calls = [];
  const byId = new Map();
  const add = (id, name, args) => {
    const m = /^mcp__(.+?)__(.+)$/.exec(name ?? "");
    const call = { tool: m ? m[2] : name, server: m ? m[1] : null, args: args ?? {}, result: null };
    calls.push(call);
    if (id) byId.set(id, call);
  };
  const settle = (id, content) => {
    const call = byId.get(id);
    if (call) call.result = parseJson(textOf(content));
  };
  for (const r of rows) {
    // Claude Code transcript
    const content = r?.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "tool_use") add(b.id, b.name, b.input);
        if (b.type === "tool_result") settle(b.tool_use_id, b.content);
      }
    }
    // Codex rollout
    const p = r?.type === "response_item" ? r.payload : null;
    if (p?.type === "function_call" || p?.type === "custom_tool_call") add(p.call_id, p.name, parseJson(p.arguments));
    if (p?.type === "function_call_output" || p?.type === "custom_tool_call_output") settle(p.call_id, p.output);
  }
  return calls;
}

/** What the person typed, oldest first (Claude Code and Codex). */
export function userPrompts(ctx) {
  const rows = readLines(ctx?.session?.transcriptPath ?? ctx?.payload?.transcript_path);
  const out = [];
  for (const r of rows) {
    if (r?.type === "user" && typeof r.message?.content === "string") out.push(r.message.content);
    else if (r?.type === "user" && Array.isArray(r.message?.content)) {
      const t = r.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (t) out.push(t);
    }
    // Codex: older builds log event_msg/user_message, newer ones item_completed/UserMessage.
    // Codex also injects harness notes as user turns; they start with "<".
    if (r?.type === "event_msg" && r.payload?.type === "user_message") out.push(r.payload.message);
    if (r?.type === "event_msg" && r.payload?.type === "item_completed" && r.payload.item?.type === "UserMessage") {
      const t = textOf(r.payload.item.content);
      if (t && !t.trimStart().startsWith("<")) out.push(t);
    }
  }
  if (!out.length && typeof ctx?.payload?.prompt === "string") out.push(ctx.payload.prompt);
  return out;
}

// ---- Jev --------------------------------------------------------------------

const fpHome = () => process.env.FAILPROOFAI_HOME || join(homedir(), ".failproofai");
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

const NATIVE = {
  typesafe: { base: "https://api.typesafe.ai/v1", model: "jev-1.13.0" },
  openrouter: { base: "https://openrouter.ai/api/v1", model: "typesafe/jev-1.13" },
  vercel: { base: "https://ai-gateway.vercel.sh/typesafe/v1", model: "typesafe-ai/jev" },
  custom: { base: null, model: "jev-1.13.0" },
  failproofai: { base: null, model: "jev-1.13.0" },
};

/**
 * Where this machine's Jev lives, read from failproofai's own config
 * (`failproofai config --token …` for FailproofAI Cloud, or `failproofai jev
 * setup …` for your own key). Override with JEV_URL + JEV_API_KEY if needed.
 */
export function jevEndpoint() {
  if (process.env.JEV_URL && process.env.JEV_API_KEY) {
    return { url: process.env.JEV_URL, key: process.env.JEV_API_KEY, model: process.env.JEV_MODEL || "jev-1.13.0", wrap: false };
  }
  const cfg = readJson(join(fpHome(), "jev.json"));
  if (!cfg) throw new Error("Jev is not configured on this machine: run `failproofai config --token <key>` (FailproofAI Cloud) or `failproofai jev setup`.");
  const provider = cfg.provider ?? "typesafe";
  if (provider === "cloudflare") {
    const base = (cfg.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
    return { url: `${base}/accounts/${cfg.accountId}/ai/run`, key: cfg.apiKey ?? process.env.FAILPROOFAI_JEV_API_KEY, model: cfg.model ?? "typesafe/jev", wrap: true };
  }
  const native = NATIVE[provider] ?? NATIVE.custom;
  let key = cfg.apiKey ?? process.env.FAILPROOFAI_JEV_API_KEY;
  if (provider === "failproofai") key = readJson(join(fpHome(), "credentials.json"))?.jev?.key;
  const base = (cfg.baseUrl ?? native.base ?? "").replace(/\/+$/, "");
  if (!base || !key) throw new Error(`Jev config for provider "${provider}" is incomplete (need a base URL and a key).`);
  return { url: `${base}/systemone`, key, model: cfg.model ?? native.model, wrap: false };
}

/**
 * Ask Jev one or more typed questions about `state`.
 *
 *   const a = await askJev({
 *     state: { user_said: userPrompts(ctx), agent_request: mcpCall(ctx) },
 *     questions: {
 *       off_task: { type: "noul", instructions: "The action in `agent_request` is something the user did not ask for.",
 *                   criteria: { true: "Not part of the user's request", false: "A step in what the user asked" } },
 *     },
 *   });
 *   if (a.off_task > 0.8) return deny("…");
 *
 * Returns `{ <questionId>: number }` — the probability for `noul`, or the
 * 0-based rubric level for `score` — plus `_raw` (Jev's full answer) and
 * `_ms` (latency). Throws on transport errors; wrap it if you want a fallback.
 */
export async function askJev({ state, questions, timeoutMs = 6000 }) {
  const ep = jevEndpoint();
  const body = ep.wrap ? { model: ep.model, input: { state, questions } } : { model: ep.model, state, questions };
  const started = Date.now();
  const res = await fetch(ep.url, {
    method: "POST",
    headers: { authorization: `Bearer ${ep.key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jev ${res.status}: ${text.slice(0, 300)}`);
  let json = JSON.parse(text);
  if (ep.wrap) json = json?.result?.result ?? json?.result ?? json;
  const out = { _raw: json, _ms: Date.now() - started };
  for (const [id, a] of Object.entries(json.answers ?? {})) {
    out[id] = typeof a.noul === "number" ? a.noul : typeof a.score === "number" ? a.score : a.choice ?? null;
  }
  return out;
}

// ---- small conveniences -------------------------------------------------------

/** Trim big tool results before sending them to Jev (keeps the call cheap and fast). */
export function compact(value, maxChars = 4000) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > maxChars ? s.slice(0, maxChars) + " …[truncated]" : s;
}
