#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, DATA_FILE, load, save, pending, pendingMarkdown } from "./store.js";

const SELF = fileURLToPath(import.meta.url);

const USAGE = `pinpoint — send UI change requests from your browser to your coding agent

Usage
  pinpoint [start]                  start the bridge (browser <-> agent). Leave it running.
  pinpoint mcp                      run as a stdio MCP server (for Claude Code / Cursor / Codex)
  pinpoint print                    print pending annotations as markdown
  pinpoint resolve <id...>          mark annotations done (pins disappear in the browser)
  pinpoint install-hooks [dir]      set up Claude Code so annotations arrive automatically
  pinpoint status                   is the bridge running? how many pending?
  pinpoint clear                    delete all annotations

Options
  --port <n>        bridge port (default ${DEFAULT_PORT}, or $PINPOINT_PORT)
  --project <dir>   mirror pending annotations to <dir>/.pinpoint/pending.md
  --print           echo each new annotation to stdout as it arrives
  --consume         (with print) mark everything printed as resolved
  --quiet           no log output

Files
  ${DATA_FILE}   annotations (screenshots inline, no loose image files)
  $PINPOINT_HOME overrides that location

Examples
  pinpoint --project ~/code/my-app
  claude mcp add pinpoint -s user -- node ${SELF} mcp
`;

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("-") ? args.shift() : args.some((a) => /^(-h|--help)$/.test(a)) ? "help" : "start";
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);
// Positional arguments with every `--flag` and its value removed, so `resolve abc --port 7399`
// doesn't try to resolve an annotation called "7399".
function positionals() {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (args[i + 1] && !args[i + 1].startsWith("--") && !["print", "consume", "quiet", "hook"].includes(args[i].slice(2))) i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}
const port = Number(opt("port", DEFAULT_PORT));
const base = `http://127.0.0.1:${port}`;

async function bridge(path, init) {
  const res = await fetch(base + path, init);
  if (!res.ok) throw new Error(`bridge ${res.status}`);
  return res.json();
}
async function up() {
  try {
    const h = await bridge("/health");
    return h.service === "pinpoint-bridge";
  } catch { return false; }
}
// Reads work whether or not the daemon is running: both sides share the same JSON store.
async function readDb() {
  if (await up()) return { annotations: (await bridge("/annotations?status=all&images=1")).annotations };
  return load();
}

switch (cmd) {
  case "help":
    process.stdout.write(USAGE);
    break;

  case "start": {
    const { startDaemon } = await import("./daemon.js");
    try {
      await startDaemon({ port, project: opt("project", process.env.PINPOINT_PROJECT || null), print: flag("print"), quiet: flag("quiet") });
    } catch (e) {
      if (e.code === "EADDRINUSE") {
        console.error(`[pinpoint] port ${port} is already in use.`);
        console.error(`[pinpoint] If the bridge is already running you're done. Otherwise use a free port:`);
        console.error(`[pinpoint]     node ${SELF} --port ${port + 1}`);
        console.error(`[pinpoint] and set the same port in the extension popup ("Bridge port").`);
        process.exit(1);
      }
      throw e;
    }
    break;
  }

  case "mcp": {
    const { startStdio } = await import("./mcp-stdio.js");
    await startStdio({ port });
    break;
  }

  case "status": {
    if (await up()) {
      const h = await bridge("/health");
      console.log(`bridge running on :${h.port}${h.project ? `  ·  project ${h.project}` : ""}`);
      console.log(`${h.pending} pending annotation${h.pending === 1 ? "" : "s"}  ·  store ${h.dataFile}`);
    } else {
      const db = load();
      // Distinguish "nothing there" from "something else is squatting on the port".
      let squatter = false;
      try { await fetch(base + "/health"); squatter = true; } catch {}
      console.log(squatter
        ? `port ${port} answers, but it is NOT the pinpoint bridge — something else is using it. Start the bridge on another port with --port and set the same number in the extension popup.`
        : `bridge NOT running on :${port}`);
      console.log(`${pending(db).length} pending annotation(s) in ${DATA_FILE}`);
      process.exitCode = 1;
    }
    break;
  }

  case "print": {
    const db = await readDb();
    const items = pending(db);
    // Hook mode: silent when there is nothing to say, so it can run on every prompt.
    if (flag("hook")) {
      if (!items.length) break;
      // Separate what the agent has not seen yet from what it has already been shown and has not
      // finished. Re-dumping everything on every prompt trains it to ignore the block.
      const fresh = items.filter((a) => !a.notifiedAt);
      const older = items.filter((a) => a.notifiedAt);
      const lines = [`<pinpoint count="${items.length}" new="${fresh.length}">`];
      lines.push(
        fresh.length
          ? `The developer just marked ${fresh.length} thing${fresh.length === 1 ? "" : "s"} in their browser. This is a direct request from them — as real as the message below.`
          : `${older.length} thing${older.length === 1 ? " the developer marked is" : "s the developer marked are"} still waiting.`,
        ``,
        `Do this now, before anything else:`,
        `1. Say in one short line what is waiting (for example: "2 notes pending: the Registration ID label, the Email label").`,
        `2. If their message below is about the interface, or if they have not asked for anything else, make ${fresh.length || older.length === 1 ? "the change" : "the changes"}.`,
        `3. After each one is done, run \`node ${SELF} resolve <id>\` (or the pinpoint MCP tool resolve_annotation) so the marker clears in their browser. Never say something is done without resolving it.`,
        `Never ignore this block silently — if you are not going to act on it now, say so.`,
        ``
      );
      if (fresh.length) lines.push(pendingMarkdown({ annotations: fresh }, { channel: "file", cliPath: SELF }));
      if (older.length) {
        lines.push(
          fresh.length ? `\nAlso still unresolved from earlier — details via the pinpoint MCP tool get_annotation:` : `Details via the pinpoint MCP tool get_annotation:`,
          ...older.map((a) => `- \`${a.id}\` #${a.number} "${a.comment}" — ${a.element.selector} on ${a.page.url}`),
          ``
        );
      }
      lines.push(`</pinpoint>`);
      process.stdout.write(lines.join("\n") + "\n");
      // Remember what has been shown, so the next prompt can tell new from outstanding.
      for (const a of fresh) await markNotified(a.id);
      break;
    }
    process.stdout.write(pendingMarkdown(db, { channel: "file", cliPath: SELF }));
    if (flag("consume")) {
      for (const a of items) await resolveOne(a.id);
    }
    break;
  }

  case "resolve": {
    const ids = positionals();
    if (!ids.length) {
      console.error("usage: pinpoint resolve <id|number> [...]");
      process.exit(2);
    }
    let ok = 0;
    for (const id of ids) (await resolveOne(id)) ? ok++ : console.error(`no annotation "${id}"`);
    console.error(`[pinpoint] resolved ${ok}/${ids.length}`);
    process.exitCode = ok === ids.length ? 0 : 1;
    break;
  }

  case "clear": {
    if (await up()) await bridge("/annotations", { method: "DELETE" });
    else save({ nextNumber: 1, annotations: [] });
    console.error("[pinpoint] cleared");
    break;
  }

  case "install-hooks": {
    const { installHooks } = await import("./hooks.js");
    const dir = path.resolve(positionals()[0] || process.cwd());
    const r = installHooks(dir, SELF, { port });
    console.error(`[pinpoint] ${r.message}`);
    console.error(`[pinpoint] ${r.file}`);
    if (r.added.length) console.error(`[pinpoint] hooks: ${r.added.join(", ")}`);
    break;
  }

  default:
    console.error(`unknown command "${cmd}"\n`);
    process.stdout.write(USAGE);
    process.exit(2);
}

async function markNotified(id) {
  if (await up()) {
    try { await bridge(`/annotations/${encodeURIComponent(id)}/notified`, { method: "POST" }); } catch {}
    return;
  }
  const db = load();
  const a = db.annotations.find((x) => x.id === id);
  if (a) { a.notifiedAt = new Date().toISOString(); save(db); }
}

async function resolveOne(id, note) {
  if (await up()) return (await bridge(`/annotations/${encodeURIComponent(id)}/resolve`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note }),
  })).ok;
  const db = load();
  const a = db.annotations.find((x) => x.id === id || String(x.number) === String(id));
  if (!a) return false;
  a.status = "resolved";
  a.resolvedAt = new Date().toISOString();
  if (note) a.resolution = note;
  save(db);
  return true;
}
