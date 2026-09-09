#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, DATA_FILE, load, save, pending, pendingMarkdown, findAnnotation } from "./store.js";

const SELF = fileURLToPath(import.meta.url);

const USAGE = `pinpoint — send UI change requests from your browser to your coding agent

Usage
  node cli.js setup [dir]              set everything up, asking as it goes (start here)
  node cli.js [start]                  start the bridge (browser <-> agent). Leave it running.
  node cli.js mcp                      run as a stdio MCP server (for Claude Code / Cursor / Codex)
  node cli.js print                    print pending annotations as markdown
  node cli.js resolve <id...>          mark annotations done (pins disappear in the browser)
  node cli.js install-hooks [dir]      set up Claude Code so annotations arrive automatically
  node cli.js install-native-host      let the extension's "Start bridge" button start the bridge
  node cli.js status                   is the bridge running? how many pending?
  node cli.js clear                    delete all annotations

Options
  --port <n>        bridge port (default ${DEFAULT_PORT}, or $PINPOINT_PORT)
  --project <dir>   mirror pending annotations to <dir>/.pinpoint/pending.md
  --print           echo each new annotation to stdout as it arrives
  --consume         (with print) mark everything printed as resolved
  --quiet           no log output
  --uninstall       (with install-native-host) remove it again
  --id <id>         (with install-native-host) also allow this extension id
  --yes             (with setup) take every default instead of asking
  --no-start        (with setup) wire everything up but do not start the bridge

Files
  ${DATA_FILE}   annotations (screenshots inline, no loose image files)
  $PINPOINT_HOME overrides that location

Examples
  node cli.js setup
  node cli.js --project ~/code/my-app
  claude mcp add pinpoint -s user -- node ${SELF} mcp
`;

const args = process.argv.slice(2);
// The subcommand may sit after flags (`--port 7332 status`), so find it wherever it is rather
// than only at position 0 — otherwise a flag-first invocation silently starts a daemon instead.
const CMDS = ["setup", "start", "mcp", "print", "resolve", "install-hooks", "install-native-host", "status", "clear", "help"];
const VALUE_FLAGS = ["--port", "--project"];
function pickCommand() {
  // A leading positional is the command, whatever it is — so an unknown one still reports itself
  // rather than silently starting a daemon.
  if (args[0] && !args[0].startsWith("-")) return args.shift();
  // Otherwise look past the flags for a real subcommand, skipping any token that is a flag's value.
  const i = args.findIndex((a, n) => CMDS.includes(a) && !VALUE_FLAGS.includes(args[n - 1]));
  if (i >= 0) return args.splice(i, 1)[0];
  return args.some((a) => /^(-h|--help)$/.test(a)) ? "help" : "start";
}
const cmd = pickCommand();
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
      if (args[i + 1] && !args[i + 1].startsWith("--") && !["print", "consume", "quiet", "hook", "uninstall", "yes", "no-start"].includes(args[i].slice(2))) i++;
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

  case "setup": {
    const { runSetup } = await import("./setup.js");
    const ids = args.reduce((a, x, i) => (x === "--id" && args[i + 1] ? [...a, args[i + 1]] : a), []);
    try {
      await runSetup({
        project: positionals()[0] || opt("project", null),
        port, yes: flag("yes"), start: !flag("no-start"), ids,
      });
    } catch (e) {
      // Same contract as install-hooks: a readable sentence, never a stack trace at the moment a
      // first-timer is deciding whether this thing works.
      console.error(`[pinpoint] ${e.message}`);
      process.exit(1);
    }
    break;
  }

  case "start": {
    const { startDaemon } = await import("./daemon.js");
    try {
      // restartable: this IS its own process, so POST /restart may re-exec it.
      await startDaemon({ port, project: opt("project", process.env.PINPOINT_PROJECT || null), print: flag("print"), quiet: flag("quiet"), restartable: true });
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
        `3. After each one is done, resolve it WITH a note saying what you changed and where — \`node ${SELF} resolve <id> --note "what you changed"\`, or the pinpoint MCP tool resolve_annotation. The marker clears in their browser and your note is shown there as your reply, so "done" is not an answer. Never say something is done without resolving it.`,
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
      console.error('usage: node cli.js resolve <id|number> [...] [--note "what you changed"]');
      process.exit(2);
    }
    let ok = 0;
    // The note is the developer's answer, shown in their browser next to what they asked for.
    const note = opt("note", null);
    for (const id of ids) (await resolveOne(id, note)) ? ok++ : console.error(`no annotation "${id}" — numbers are per page, so use the id if the same number exists on more than one page`);
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
    // installHooks throws readable sentences ("no such directory: …"); without this they reach
    // the user as a raw stack trace, which is exactly the moment a first-timer gives up.
    let r;
    try {
      r = installHooks(dir, SELF, { port });
    } catch (e) {
      console.error(`[pinpoint] ${e.message}`);
      process.exit(1);
    }
    console.error(`[pinpoint] ${r.message}`);
    console.error(`[pinpoint] ${r.file}`);
    if (r.added.length) console.error(`[pinpoint] hooks: ${r.added.join(", ")}`);
    break;
  }

  case "install-native-host": {
    const { installNativeHost } = await import("./native-host.js");
    // Repeatable --id, for a second checkout or a differently-packed build.
    const ids = args.reduce((a, x, i) => (x === "--id" && args[i + 1] ? [...a, args[i + 1]] : a), []);
    let r;
    try {
      r = installNativeHost({ ids, uninstall: flag("uninstall"), project: opt("project", process.env.PINPOINT_PROJECT || null) });
    } catch (e) {
      console.error(`[pinpoint] ${e.message}`);
      process.exit(1);
    }
    console.error(`[pinpoint] ${r.message}`);
    for (const f of r.removed || r.files) console.error(`[pinpoint] ${r.removed ? "removed" : "wrote"} ${f}`);
    if (!r.removed) {
      console.error(`[pinpoint] launcher ${r.wrapperPath}  (node: ${r.node})`);
      console.error(`[pinpoint] extension ${r.ids.join(", ")}`);
      console.error(`[pinpoint] If the button still says "setup needed", quit and reopen the browser once.`);
    }
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
  const a = findAnnotation(db, id);
  if (!a) return false;
  a.status = "resolved";
  a.resolvedAt = new Date().toISOString();
  if (note) a.resolution = note;
  save(db);
  return true;
}
