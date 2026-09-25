#!/usr/bin/env node
// buildathon — set up the four agents on this machine and run their tasks.
//
//   buildathon setup                 trust the agent folders in Claude Code and Codex
//   buildathon doctor                check the harnesses, failproofai and the MCP servers
//   buildathon tasks [agent]         list tasks
//   buildathon run <agent> <task> [--harness claude|codex] [--model <m>]
//   buildathon log <agent> [--last N]  show the tool calls of recent runs
//   buildathon unlock <passphrase>   open the sealed final round (announced at the event)
//   buildathon pack <team>           bundle your policies into one file for the review
//
// Agents: itsm, legal, health, finance.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finalRound, unseal } from "../env/final.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = join(REPO, "agents");
const BUILTIN_TOOLS = ["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Task", "Agent"];

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function agents() {
  return readdirSync(AGENTS_DIR)
    .filter((d) => existsSync(join(AGENTS_DIR, d, "tasks.json")))
    .map((d) => {
      const dir = join(AGENTS_DIR, d);
      const tasks = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"));
      const final = finalRound(dir);
      return { key: tasks.agent, dir, tasks: [...tasks.tasks, ...(final?.tasks ?? []).map((t) => ({ ...t, final: true }))], sealed: existsSync(join(dir, "final.enc")) && !final };
    });
}

function agent(key) {
  const a = agents().find((x) => x.key === key || x.dir.endsWith(`/${key}`) || x.dir.endsWith(`/${key}-agent`));
  if (!a) die(`Unknown agent "${key}". Agents: ${agents().map((x) => x.key).join(", ")}`);
  return a;
}

function die(msg) {
  console.error(c.red(msg));
  process.exit(1);
}

function has(cmd) {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
}

function version(cmd, args = ["--version"]) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20000 });
  return (r.stdout || r.stderr || "").trim().split("\n")[0];
}

function writeAtomic(path, text) {
  const tmp = `${path}.buildathon-tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

// ---- setup -----------------------------------------------------------------

function trustClaude(dirs) {
  const path = join(homedir(), ".claude.json");
  let cfg = {};
  if (existsSync(path)) {
    try {
      cfg = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      console.log(c.yellow(`  ! ${path} is not valid JSON; open each agent folder in Claude Code once and accept the trust prompt.`));
      return;
    }
  }
  cfg.projects ??= {};
  for (const d of dirs) {
    cfg.projects[d] = { ...(cfg.projects[d] ?? {}), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
  }
  writeAtomic(path, JSON.stringify(cfg, null, 2));
  console.log(`  ${c.green("✓")} Claude Code trusts the ${dirs.length} agent folders (${path})`);
}

function trustCodex(dirs) {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  mkdirSync(home, { recursive: true });
  const path = join(home, "config.toml");
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  let added = 0;
  for (const d of dirs) {
    const header = `[projects."${d}"]`;
    if (text.includes(header)) continue;
    text += `${text.endsWith("\n") || text === "" ? "" : "\n"}\n${header}\ntrust_level = "trusted"\n`;
    added++;
  }
  if (added) writeAtomic(path, text);
  console.log(`  ${c.green("✓")} Codex trusts the ${dirs.length} agent folders (${path}${added ? `, ${added} added` : ", already there"})`);
}

function setup() {
  console.log(c.bold("Setting up the buildathon agents"));
  const list = agents();
  const dirs = list.map((a) => a.dir);
  if (has("claude")) trustClaude(dirs);
  else console.log(c.yellow("  ! Claude Code not found (npm i -g @anthropic-ai/claude-code) — skipped"));
  if (has("codex")) trustCodex(dirs);
  else console.log(c.yellow("  ! Codex not found (npm i -g @openai/codex) — skipped"));
  console.log(`\nAgents: ${list.map((a) => c.bold(a.key)).join(", ")}`);
  console.log(`Next: ${c.bold("buildathon doctor")}, then ${c.bold("buildathon tasks itsm")}.`);
}

// ---- doctor ----------------------------------------------------------------

function probeServer(dir) {
  const input =
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "doctor", version: "0" } } }) +
    "\n" +
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) +
    "\n";
  const r = spawnSync("node", ["server.mjs"], { cwd: dir, input, encoding: "utf8", timeout: 10000 });
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const tools = lines.find((m) => m.id === 2)?.result?.tools ?? [];
  return tools.length;
}

function doctor() {
  let ok = true;
  const line = (good, text, hint) => {
    console.log(`  ${good ? c.green("✓") : c.red("✗")} ${text}${!good && hint ? c.dim(`  → ${hint}`) : ""}`);
    if (!good) ok = false;
  };
  console.log(c.bold("Harnesses"));
  const [maj] = process.versions.node.split(".").map(Number);
  line(maj >= 20, `node ${process.versions.node}`, "install Node 20+");
  const hasClaude = has("claude");
  const hasCodex = has("codex");
  line(hasClaude || hasCodex, `claude: ${hasClaude ? version("claude") : "missing"} · codex: ${hasCodex ? version("codex") : "missing"}`, "install at least one harness");
  console.log(c.bold("failproofai"));
  const fp = has("failproofai");
  line(fp, fp ? `failproofai ${version("failproofai")}` : "failproofai missing", "npm i -g failproofai@next && failproofai config --token <your key>");
  console.log(c.bold("Agents"));
  for (const a of agents()) {
    let n = 0;
    try {
      n = probeServer(a.dir);
    } catch {
      n = 0;
    }
    line(n > 0, `${a.key.padEnd(8)} ${n} tools, ${a.tasks.length} tasks`, `node ${join(a.dir, "server.mjs")} fails to start`);
  }
  console.log(ok ? c.green("\nAll good.") : c.red("\nFix the items above, then run doctor again."));
  process.exit(ok ? 0 : 1);
}

// ---- tasks / run / log -------------------------------------------------------

function tasks(key) {
  for (const a of key ? [agent(key)] : agents()) {
    console.log(c.bold(`${a.key}`) + c.dim(`  (${a.dir})`));
    for (const t of a.tasks) console.log(`  ${c.bold(t.id.padEnd(10))} ${t.final ? c.yellow("[final] ") : ""}${t.prompt}`);
    if (a.sealed) console.log(c.dim("  (final-round tasks are sealed — `buildathon unlock <passphrase>` when it is announced)"));
  }
}

function argValue(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function newestLogs(dir, since) {
  const runs = join(dir, ".runs");
  if (!existsSync(runs)) return [];
  return readdirSync(runs)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f: join(runs, f), t: statSync(join(runs, f)).mtimeMs }))
    .filter((x) => x.t >= since)
    .sort((a, b) => a.t - b.t)
    .map((x) => x.f);
}

function printCalls(file) {
  const rows = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const r of rows) {
    const args = JSON.stringify(r.args);
    console.log(`  ${r.isError ? c.red("✗") : c.green("•")} ${c.bold(r.tool)} ${c.dim(args.length > 160 ? args.slice(0, 157) + "..." : args)}`);
  }
  return rows.length;
}

async function run(key, taskId, args) {
  const a = agent(key);
  const t = a.tasks.find((x) => x.id.toLowerCase() === String(taskId).toLowerCase());
  if (!t) die(`No task ${taskId} for ${a.key}. Run: buildathon tasks ${a.key}`);
  const harness = argValue(args, "--harness", has("claude") ? "claude" : "codex");
  const model = argValue(args, "--model", null);
  const prompt = `[${t.id}] ${t.prompt}`;
  const outDir = join(a.dir, ".runs", "transcripts");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = join(outDir, `${t.id}-${harness}-${model ? model.replace(/[^a-z0-9.]+/gi, "_") + "-" : ""}${stamp}.jsonl`);

  let cmd, cargs;
  if (harness === "claude") {
    cmd = "claude";
    cargs = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--max-turns", "60",
      "--allowedTools", `mcp__${a.key}`, "--disallowedTools", BUILTIN_TOOLS.join(",")];
    if (model) cargs.push("--model", model);
    cargs.push(...extraArgs("BUILDATHON_CLAUDE_ARGS"));
  } else if (harness === "codex") {
    cmd = "codex";
    // Codex skips hooks it has not been told to trust, and trust can only be
    // persisted through /hooks in its TUI — so a scripted run vouches for them.
    cargs = ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", prompt];
    if (model) cargs.splice(1, 0, "-m", model);
    cargs.splice(1, 0, ...extraArgs("BUILDATHON_CODEX_ARGS"));
  } else die(`--harness must be claude or codex`);

  console.log(`${c.bold(a.key)} ${c.bold(t.id)} on ${c.bold(harness)}: ${t.prompt}`);
  const started = Date.now();
  const out = [];
  const code = await new Promise((res) => {
    const p = spawn(cmd, cargs, { cwd: a.dir, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => process.env.BUILDATHON_VERBOSE && process.stderr.write(d));
    p.on("close", res);
  });
  writeFileSync(outFile, Buffer.concat(out));
  const final = finalText(harness, Buffer.concat(out).toString("utf8"));
  console.log(c.dim(`\nTool calls:`));
  let n = 0;
  for (const f of newestLogs(a.dir, started - 1000)) n += printCalls(f);
  if (!n) console.log(c.dim("  (none)"));
  if (final) console.log(`\n${c.bold("Agent:")} ${final}`);
  console.log(c.dim(`\nexit ${code} · ${Math.round((Date.now() - started) / 1000)}s · transcript ${outFile}`));
}

/** Extra harness flags as a JSON array in an env var (used by the organisers'
 *  lab to run with hooks off or a pinned model). */
function extraArgs(name) {
  if (!process.env[name]) return [];
  try {
    const v = JSON.parse(process.env[name]);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    die(`${name} must be a JSON array of strings`);
  }
}

function finalText(harness, raw) {
  const lines = raw.split("\n").filter(Boolean);
  let last = "";
  for (const l of lines) {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      continue;
    }
    if (harness === "claude" && m.type === "result") last = m.result ?? last;
    if (harness === "codex" && m.item?.type === "agent_message") last = m.item.text ?? last;
  }
  return last;
}

function log(key, args) {
  const a = agent(key);
  const n = Number(argValue(args, "--last", 1));
  const files = newestLogs(a.dir, 0).slice(-n);
  if (!files.length) return console.log("No runs yet.");
  for (const f of files) {
    console.log(c.bold(f));
    printCalls(f);
  }
}

function unlock(passphrase) {
  if (!passphrase) die("usage: buildathon unlock <passphrase>");
  let n = 0;
  for (const a of agents()) {
    const enc = join(a.dir, "final.enc");
    if (!existsSync(enc)) continue;
    let plain;
    try {
      plain = unseal(readFileSync(enc, "utf8"), passphrase);
    } catch {
      die(`Wrong passphrase (could not open ${a.key}'s final round).`);
    }
    writeFileSync(join(a.dir, "final.json"), plain);
    const tasks = JSON.parse(plain).tasks ?? [];
    console.log(`  ${c.green("✓")} ${a.key}: ${tasks.length} final-round tasks — ${tasks.map((t) => t.id).join(", ")}`);
    n++;
  }
  if (!n) die("No sealed final round found.");
  console.log(`\nFinal round unlocked. Every session on these tasks counts. ${c.bold("buildathon tasks <agent>")} to see them.`);
}

/** Bundle every agent's policies into one Markdown file for the organisers' review. */
function pack(team) {
  if (!team) die("usage: buildathon pack <team-name>");
  const parts = [`# Buildathon submission — ${team}\n`, `Generated ${new Date().toISOString()}\n`];
  let files = 0;
  for (const a of agents()) {
    const dir = join(a.dir, ".failproofai", "policies");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => /\.(mjs|js|ts)$/.test(x)).sort()) {
      parts.push(`\n## ${a.key} — ${f}\n\n\`\`\`js\n${readFileSync(join(dir, f), "utf8").trimEnd()}\n\`\`\`\n`);
      files++;
    }
  }
  if (!files) die("No policy files found under agents/*/.failproofai/policies/.");
  const out = join(REPO, `submission-${team.replace(/[^a-z0-9_-]+/gi, "_")}.md`);
  writeFileSync(out, parts.join(""));
  console.log(`${c.green("✓")} ${files} policy files → ${out}\nUpload this file where the organisers tell you. Your Jev evaluations are read straight from FailproofAI Cloud.`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "setup": setup(); break;
  case "doctor": doctor(); break;
  case "tasks": tasks(rest[0]); break;
  case "run": await run(rest[0], rest[1], rest.slice(2)); break;
  case "log": log(rest[0], rest.slice(1)); break;
  case "unlock": unlock(rest[0]); break;
  case "pack": pack(rest[0]); break;
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 10).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
