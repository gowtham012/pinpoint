// Installs Claude Code hooks so pending annotations reach the agent by themselves.
//
// Without this, the developer has to remember to say "apply my pinpoint annotations". With it,
// Claude sees whatever is pending at the start of a session and on every prompt — so clicking an
// element in the browser is enough, and the next thing typed in Claude Code carries the request.
//
// Both hooks run `cli.js print --hook`, which prints nothing at all when there is nothing pending,
// so the only cost in a normal session is one fast process spawn.
import fs from "node:fs";
import path from "node:path";

const MARK = "pinpoint";

export function hookCommand(cliPath, { port } = {}) {
  const p = port && port !== 7331 ? ` --port ${port}` : "";
  return `node ${JSON.stringify(cliPath).slice(1, -1)} print --hook${p}`;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// Existing entries that already point at pinpoint are replaced (so re-running updates the path),
// everything else in the file is left exactly as it was.
function mergeEvent(existing, command) {
  const kept = (existing || []).filter((entry) => !JSON.stringify(entry).includes(MARK));
  return [...kept, { hooks: [{ type: "command", command }] }];
}

export function installHooks(projectDir, cliPath, { port } = {}) {
  if (!fs.existsSync(projectDir)) throw new Error(`no such directory: ${projectDir}`);
  const dir = path.join(projectDir, ".claude");
  const file = path.join(dir, "settings.json");
  const command = hookCommand(cliPath, { port });

  const existing = readJson(file);
  if (fs.existsSync(file) && existing === null) {
    throw new Error(`${file} exists but is not valid JSON — fix or move it, then run this again`);
  }
  const settings = existing || {};
  settings.hooks = settings.hooks || {};

  const already = JSON.stringify(settings.hooks).includes(MARK);
  settings.hooks.SessionStart = mergeEvent(settings.hooks.SessionStart, command);
  settings.hooks.UserPromptSubmit = mergeEvent(settings.hooks.UserPromptSubmit, command);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");

  return {
    file,
    added: ["SessionStart", "UserPromptSubmit"],
    message: already
      ? "Claude Code hooks updated — annotations still arrive automatically."
      : "Claude Code will now receive your annotations automatically (restart any open session once).",
  };
}
