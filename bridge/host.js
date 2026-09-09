#!/usr/bin/env node
// Chrome native messaging host: the one thing that lets the extension's "Start bridge" button
// actually start a process. A browser cannot spawn anything itself, so this sits behind Chrome's
// native messaging boundary and is deliberately tiny.
//
// It can do exactly ONE thing: run the cli.js that sits next to it, on a port number. It never
// takes a path, a command name, a project directory or a shell string from the message — the only
// value that crosses the boundary is an integer. Everything else is baked in at install time
// (see native-host.js, which writes the wrapper and puts PINPOINT_PROJECT/PINPOINT_HOME in it).
//
// Protocol: 4-byte little-endian length, then that many bytes of UTF-8 JSON, on stdin and stdout.
// NOTHING else may ever be written to stdout — one stray byte corrupts the stream and Chrome
// kills the host. Diagnostics go to the log file.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DATA_DIR, DEFAULT_PORT } from "./store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "cli.js");
const LOG = path.join(DATA_DIR, "bridge.log");
const MAX_FRAME = 64 * 1024;

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}
const fail = (code, error) => { send({ ok: false, code, error }); process.exit(0); };

async function health(port, ms = 400) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
    clearTimeout(t);
    const h = await res.json();
    return h && h.service === "pinpoint-bridge" ? h : null;
  } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logTail(bytes = 2000) {
  try {
    const buf = fs.readFileSync(LOG);
    return buf.subarray(Math.max(0, buf.length - bytes)).toString("utf8").trim();
  } catch { return ""; }
}

async function start(port) {
  const already = await health(port);
  if (already) return send({ ok: true, cmd: "start", port, already: true, project: already.project || null });

  if (!fs.existsSync(CLI)) return fail("no_cli", `${CLI} is missing — reinstall Pinpoint, then run: node <pinpoint>/bridge/cli.js install-native-host`);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Truncate: the tail of this file is the error the popup shows, and a month of old starts
  // would bury today's reason.
  const fd = fs.openSync(LOG, "w");
  let child;
  try {
    // spawn(file, args) — never a shell string, and never exec(). There is no shell here and
    // there must never be one: this argv is the whole security boundary.
    child = spawn(process.execPath, [CLI, "--port", String(port)], {
      detached: true,                 // its own session, so Chrome reaping us doesn't take it
      stdio: ["ignore", fd, fd],      // our own stdio IS the protocol; the child must not touch it
      cwd: HERE,
    });
    child.unref();
  } catch (e) {
    fs.closeSync(fd);
    return fail("spawn_failed", String(e.message || e));
  }
  fs.closeSync(fd);

  // Don't claim success on spawn — confirm the bridge is actually answering. This is what turns
  // cli.js's own "port is already in use" paragraph into the popup's error text, for free.
  let exited = false;
  child.on("exit", () => { exited = true; });
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    const h = await health(port);
    if (h) return send({ ok: true, cmd: "start", port, pid: child.pid, project: h.project || null });
    if (exited) break;
  }
  const tail = logTail();
  return fail(/in use/i.test(tail) ? "port_busy" : "no_start",
    tail || `the bridge did not come up on port ${port} — start it in a terminal to see why: node ${CLI}`);
}

function readFrame() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0, want = -1;
    const done = (v) => { process.stdin.off("data", on); process.stdin.off("end", end); resolve(v); };
    const end = () => done(null);
    const on = (c) => {
      chunks.push(c); size += c.length;
      const buf = Buffer.concat(chunks);
      if (want < 0 && buf.length >= 4) {
        want = buf.readUInt32LE(0);
        if (want > MAX_FRAME) return done({ tooBig: true });
      }
      if (want >= 0 && buf.length >= 4 + want) {
        try { return done({ msg: JSON.parse(buf.subarray(4, 4 + want).toString("utf8")) }); }
        catch { return done({ bad: true }); }
      }
    };
    process.stdin.on("data", on);
    process.stdin.on("end", end);
  });
}

const frame = await readFrame();
if (!frame || frame.bad || frame.tooBig) fail("bad_request", "unreadable message");
const msg = frame.msg;

switch (msg?.cmd) {
  case "ping":
    send({ ok: true, cmd: "ping", version: createRequire(import.meta.url)("./package.json").version, cli: CLI, defaultPort: DEFAULT_PORT });
    break;
  case "start": {
    const port = msg.port;
    // The only value that crosses this boundary. A string, a float or a privileged port is refused.
    if (!Number.isInteger(port) || port < 1024 || port > 65535) fail("bad_port", "port must be a whole number between 1024 and 65535");
    await start(port);
    break;
  }
  default:
    fail("bad_request", `unknown command ${JSON.stringify(msg?.cmd ?? null)}`);
}
process.exit(0);
