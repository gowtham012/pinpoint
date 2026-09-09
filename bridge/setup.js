// Everything between `git clone` and a working Pinpoint, asked in the terminal.
//
// Dependency-free on purpose, and loaded by cli.js through a dynamic import, so `node cli.js setup`
// runs in a fresh clone *before* npm install — installing the bridge's own dependencies is its first
// step. Nothing here may import the MCP SDK at the top level.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "./store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const EXT = path.join(REPO, "extension");
const CLI = path.join(HERE, "cli.js");

const say = (s = "") => console.error(s ? `[pinpoint] ${s}` : "");
const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const has = (cmd) => spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;

async function bridgeHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// ---------- prompts ----------
// `rl` is null when there is no terminal to ask (--yes, CI, a pipe): every question then answers
// itself with the default rather than hanging forever on a stdin that will never arrive.
async function ask(rl, question, def = "") {
  if (!rl) return def;
  const a = (await rl.question(`  ${question}${def ? ` [${def}]` : ""}: `)).trim();
  return a || def;
}
async function confirm(rl, question, def = true) {
  if (!rl) return def;
  const a = (await rl.question(`  ${question} [${def ? "Y/n" : "y/N"}]: `)).trim().toLowerCase();
  return a ? a.startsWith("y") : def;
}

// ---------- steps ----------
function installDeps() {
  if (fs.existsSync(path.join(HERE, "node_modules", "@modelcontextprotocol"))) return false;
  say("installing the bridge's dependencies…");
  const r = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: HERE, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error("npm install failed — run it yourself in bridge/ and try again");
  return true;
}

function claudeMcp(port) {
  if (!has("claude")) {
    say("the `claude` CLI is not on PATH. When you have it, run:");
    say(`    claude mcp add pinpoint -s user -- node ${CLI} mcp${port === DEFAULT_PORT ? "" : ` --port ${port}`}`);
    return false;
  }
  // Remove first so re-running updates a stale path instead of failing on "already exists".
  spawnSync("claude", ["mcp", "remove", "pinpoint", "-s", "user"], { stdio: "ignore" });
  const args = ["mcp", "add", "pinpoint", "-s", "user", "--", "node", CLI, "mcp"];
  if (port !== DEFAULT_PORT) args.push("--port", String(port));
  const r = spawnSync("claude", args, { stdio: "ignore" });
  if (r.status !== 0) { say("`claude mcp add` failed — run it yourself, the line is in the README"); return false; }
  say("Claude Code: MCP server registered");
  return true;
}

function clipboard(text) {
  const cmds = process.platform === "darwin" ? [["pbcopy", []]]
    : process.platform === "win32" ? [["clip", []]]
    : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  for (const [cmd, args] of cmds) {
    if (!has(cmd)) continue;
    if (spawnSync(cmd, args, { input: text }).status === 0) return true;
  }
  return false;
}

function openInBrowser(browser, url) {
  try {
    if (process.platform === "darwin" && browser?.app) return spawnSync("open", ["-a", browser.app, url], { stdio: "ignore" }).status === 0;
    if (process.platform === "win32") return spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" }).status === 0;
    for (const bin of browser?.bin || []) if (has(bin)) return spawnSync(bin, [url], { stdio: "ignore", detached: true }).status === 0;
  } catch {}
  return false;
}

// Poll until the extension talks to the bridge, or the developer presses Enter. The bridge records
// the moment in /health, so this is a real check rather than a pause.
async function waitForExtension(rl, port, name) {
  const deadline = Date.now() + 180_000;
  let skipped = false;
  const enter = rl ? rl.question("").then(() => { skipped = true; }) : null;
  say(`waiting for ${name} to connect… (Enter to skip)`);
  while (Date.now() < deadline && !skipped) {
    const h = await bridgeHealth(port);
    if (h?.extensionSeenAt) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (enter) enter.catch(() => {});
  return false;
}

export async function runSetup({ project = null, port = DEFAULT_PORT, yes = false, start = true, ids = [] } = {}) {
  const interactive = Boolean(process.stdin.isTTY && !yes);
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stderr }) : null;
  try {
    installDeps();
    console.error("");
    say("Pinpoint setup — everything below can be answered with Enter.");
    console.error("");

    // 1. the project whose UI you want to annotate
    // Default to where they are standing — unless that is inside this clone, where the answer is
    // never "annotate Pinpoint itself".
    const cwd = path.resolve(process.cwd());
    const here = path.resolve(REPO);
    const def = cwd === here || cwd.startsWith(here + path.sep) ? "" : cwd;
    if (!project) project = expand(await ask(rl, "Which project's UI do you want to annotate?", def));
    if (!project) throw new Error("no project given — pass it as `node bridge/cli.js setup <dir>`");
    project = path.resolve(expand(project));
    if (!fs.existsSync(project)) throw new Error(`no such directory: ${project}`);
    if (!fs.existsSync(path.join(project, ".git"))) say(`note: ${project} is not a git repo — carrying on anyway`);

    // 2. a port nothing else owns. The extension popup has to agree, so this is worth saying out loud.
    const running = await bridgeHealth(port);
    const mine = running?.service === "pinpoint-bridge";
    if (running && !mine) {
      say(`port ${port} answers, but it is not the pinpoint bridge.`);
      port = Number(await ask(rl, "Which port should the bridge use?", String(port + 1))) || port + 1;
      say(`using port ${port} — set the same number in the extension popup ("Bridge port").`);
    } else if (mine) {
      say(`a bridge is already running on :${port} — leaving it alone.`);
      start = false;
    }

    // 3. agents. Detected ones are the default; the rest are one keystroke away.
    const detected = [
      has("claude") && "claude",
      (fs.existsSync(path.join(os.homedir(), ".cursor")) || fs.existsSync(path.join(project, ".cursor"))) && "cursor",
      fs.existsSync(path.join(os.homedir(), ".codex")) && "codex",
    ].filter(Boolean);
    const answer = await ask(rl, `Which agents should I wire up? (claude, cursor, codex, none)`, detected.join(", ") || "none");
    const wanted = answer.toLowerCase().split(/[,\s]+/).filter(Boolean);
    if (wanted.includes("claude")) claudeMcp(port);
    if (wanted.includes("cursor")) {
      const { writeCursorMcp } = await import("./agents.js");
      say(writeCursorMcp(project, CLI, { port }).message);
    }
    if (wanted.includes("codex")) {
      const { writeCodexMcp } = await import("./agents.js");
      const r = writeCodexMcp(CLI, { port });
      say(r.message + (r.backup ? ` (previous file kept as ${path.basename(r.backup)})` : ""));
    }
    if (!wanted.length || wanted.includes("none")) {
      say(`any other MCP client: http://127.0.0.1:${port}/mcp — or read ${path.join(project, ".pinpoint/pending.md")}`);
    }

    // 4. hooks. They write into someone else's repo, so they are asked for plainly.
    if (wanted.includes("claude")) {
      say("Hooks add two entries to your repo's .claude/settings.json that run `cli.js print --hook`.");
      say("They print nothing when nothing is pending, and re-running updates rather than duplicates.");
      if (await confirm(rl, "Install them, so notes arrive without being asked?", true)) {
        const { installHooks } = await import("./hooks.js");
        const r = installHooks(project, CLI, { port });
        say(r.message);
        say(r.file);
      }
    }

    // 5. the browser. Chrome will not let a terminal install an unpacked extension into your own
    //    profile — only the Web Store or enterprise policy can — so this goes as far as it honestly
    //    can: pick the browser, open its page, put the folder on the clipboard, then watch for it.
    const { detectBrowsers, installNativeHost } = await import("./native-host.js");
    const browsers = detectBrowsers();
    let chosen = browsers[0] || null;
    if (browsers.length > 1) {
      const names = browsers.map((b) => b.name);
      const pick = await ask(rl, `Which browser? (${names.join(", ")})`, names[0]);
      chosen = browsers.find((b) => b.name.toLowerCase() === pick.toLowerCase().trim()) || browsers[0];
    }

    if (chosen) {
      try {
        const r = installNativeHost({ ids, project });
        say(r.message);
      } catch (e) {
        say(`skipping the "Start bridge" button: ${e.message}`);
      }

      console.error("");
      say(`One thing only you can do — load the extension into ${chosen.name}:`);
      say(`  1. ${chosen.url}  →  Developer mode on`);
      // Only when someone is actually sitting there: a scripted run has no one to paste, and
      // taking over the clipboard and a browser window unasked would be rude in CI.
      say(`  2. Load unpacked  →  ${interactive && clipboard(EXT) ? "paste (the path is on your clipboard)" : "choose the folder below"}`);
      say(`     ${EXT}`);
      if (interactive) openInBrowser(chosen, chosen.url);
    }

    // 6. the bridge itself, last, because it blocks.
    console.error("");
    if (wanted.includes("claude")) say("Restart Claude Code once — it reads MCP servers and hooks at session start.");
    say(`Then open your dev site and press ${process.platform === "darwin" ? "⌥⇧A" : "Alt+Shift+A"}.`);
    console.error("");

    if (start) {
      const { startDaemon } = await import("./daemon.js");
      await startDaemon({ port, project, restartable: true });
      if (chosen && (await waitForExtension(rl, port, chosen.name))) say(`✓ Pinpoint is live in ${chosen.name}.`);
    }
  } finally {
    rl?.close();
  }
}
