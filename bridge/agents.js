// Registers the bridge as an MCP server with the agents that keep their config in a file — Claude
// Code has its own CLI (`claude mcp add`), these do not.
//
// Same shape as hooks.js: plain functions, readable sentences on failure, idempotent, and testable
// against a temp directory without a browser or an editor anywhere near it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PORT } from "./store.js";

// The command an MCP client should run. `--port` is only added when it is not the default, so a
// normal config stays as short as the one in the README.
export function mcpCommand(cliPath, { port } = {}) {
  const args = [cliPath, "mcp"];
  if (port && Number(port) !== DEFAULT_PORT) args.push("--port", String(port));
  return { command: "node", args };
}

// Cursor reads .cursor/mcp.json from the project (or ~/.cursor/mcp.json for every project). Merge
// rather than write: clobbering someone's other servers to add ours would be a bug worth an issue.
export function writeCursorMcp(projectDir, cliPath, { port, file = null } = {}) {
  const target = file || path.join(projectDir, ".cursor", "mcp.json");
  let config = {};
  if (fs.existsSync(target)) {
    try { config = JSON.parse(fs.readFileSync(target, "utf8")) || {}; }
    catch { throw new Error(`${target} exists but is not valid JSON — fix or move it, then run this again`); }
  }
  const already = Boolean(config.mcpServers?.pinpoint);
  config.mcpServers = { ...(config.mcpServers || {}), pinpoint: mcpCommand(cliPath, { port }) };

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(config, null, 2) + "\n");
  return { file: target, already, message: already ? `Cursor entry updated in ${target}` : `Cursor will find Pinpoint in ${target}` };
}

// Codex keeps one TOML file for everything, so this appends a block instead of rewriting the file,
// and keeps a .bak of whatever was there — we did not write that file and will not risk it.
export function writeCodexMcp(cliPath, { port, file = null } = {}) {
  const target = file || path.join(os.homedir(), ".codex", "config.toml");
  const { command, args } = mcpCommand(cliPath, { port });
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (/^\s*\[mcp_servers\.pinpoint\]/m.test(existing)) {
    return { file: target, already: true, backup: null, message: `Codex already has Pinpoint in ${target}` };
  }

  let backup = null;
  if (existing) {
    backup = `${target}.bak`;
    fs.writeFileSync(backup, existing);
  }
  // JSON.stringify for the strings: TOML basic strings take the same escapes, so a Windows path
  // survives with its backslashes intact.
  const block = `\n[mcp_servers.pinpoint]\ncommand = ${JSON.stringify(command)}\nargs = [${args.map((a) => JSON.stringify(a)).join(", ")}]\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, existing.replace(/\n*$/, "\n") + block);
  return { file: target, already: false, backup, message: `Codex will find Pinpoint in ${target}` };
}
