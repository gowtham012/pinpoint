// Pinpoint bridge daemon: receives annotations from the browser extension over localhost HTTP,
// persists them, exposes them to agents over MCP (Streamable HTTP at /mcp), pushes change events
// back to the extension so pins stay in sync, and optionally mirrors into a project's .pinpoint/.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.js";
import { DEFAULT_PORT, DATA_FILE, load, save, pending, pendingMarkdown, summaryLine, findAnnotation, pageKeyOf } from "./store.js";

const MAX_RESOLVED = Number(process.env.PINPOINT_MAX_RESOLVED) || 200;
// Our own launch command, so the extension can tell you how to start us and the native host can
// find us. process.argv[1] is wrong under the `bin` shim; this is the file that is actually here.
const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

// `restartable` is off by default on purpose: POST /restart re-execs the process and exits it, and
// a daemon embedded in someone else's process (the test suite) must never do that to its host.
export function startDaemon({ port = DEFAULT_PORT, project = process.env.PINPOINT_PROJECT || null, print = false, quiet = false, restartable = false } = {}) {
  let db = load();
  const events = new EventEmitter();
  events.setMaxListeners(1000);
  const log = (...a) => !quiet && console.error("[pinpoint]", ...a);

  // Monotonic version: the extension long-polls /events?since=<version> and re-syncs its pins
  // whenever this moves, so resolving from an agent clears pins without a page reload.
  let version = 1;
  // Live presence: what each coding agent is doing right now, so the browser can show it. Keyed by
  // agent name, because "agent to agent" means Claude Code and Cursor can both be connected and the
  // single slot this used to be blended them into one confusing label.
  const agents = new Map();
  let agent = null;
  function bump() {
    version++;
    events.emit("version", version);
  }

  function persist() {
    save(db);
    if (project) mirrorToProject();
    bump();
  }

  function mirrorToProject() {
    try {
      const dir = path.join(project, ".pinpoint");
      fs.mkdirSync(dir, { recursive: true });
      // Keep the mirror out of git without making the user edit .gitignore.
      const ignore = path.join(dir, ".gitignore");
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
      fs.writeFileSync(path.join(dir, "pending.md"), pendingMarkdown(db, { channel: "file", cliPath: CLI_PATH }));
      const stripped = pending(db).map((a) => ({
        ...a,
        screenshot: a.screenshot ? { width: a.screenshot.width, height: a.screenshot.height, note: "not included in this file; read it over MCP (get_annotation) or from the bridge" } : null,
      }));
      fs.writeFileSync(path.join(dir, "pending.json"), JSON.stringify(stripped, null, 2));
    } catch (e) {
      log("could not mirror to project:", e.message);
    }
  }

  const find = (id) => findAnnotation(db, id);

  // One new annotation goes to exactly one waiter. `events.once("added")` woke every blocked
  // wait_for_annotation with the SAME note, so two agents did the same work and the second
  // resolve silently overwrote the first one's reply.
  const taken = new Set();

  const api = {
    async db() { return db; },
    async add(a) {
      // Numbers are per page: your notes on a page read 1, 2, 3 whatever you marked elsewhere.
      // A single global counter meant the first note on a new site could be #14, which says
      // nothing to the person looking at it. Ids stay globally unique and are what agents use.
      const page = pageKeyOf(a);
      a.number = 1 + db.annotations.reduce((m, x) => (pageKeyOf(x) === page ? Math.max(m, x.number || 0) : m), 0);
      a.status = "pending";
      a.receivedAt = new Date().toISOString();
      db.annotations.push(a);
      // Keep the store bounded: only the most recent resolved annotations are kept.
      const resolved = db.annotations.filter((x) => x.status === "resolved");
      if (resolved.length > MAX_RESOLVED) {
        const drop = new Set(resolved.slice(0, resolved.length - MAX_RESOLVED).map((x) => x.id));
        db.annotations = db.annotations.filter((x) => !drop.has(x.id));
      }
      persist();
      events.emit("added", a);
      log("new:", summaryLine(a));
      if (print) process.stdout.write(pendingMarkdown({ annotations: [a] }) + "\n");
      return a;
    },
    // The extension posts the comment first and attaches the crop a moment later, so navigating
    // away mid-capture can never lose an annotation.
    async attachScreenshot(id, screenshot) {
      const a = find(id);
      if (!a) return false;
      if (screenshot.skipped) a.screenshotSkipped = screenshot.skipped;
      else { a.screenshot = screenshot; delete a.screenshotSkipped; }
      persist();
      events.emit("screenshot", a);
      return true;
    },
    // Returns "already" rather than true when someone else got there first, so the second agent is
    // told instead of quietly replacing the first one's reply.
    async resolve(id, note, by) {
      const a = find(id);
      if (!a) return false;
      const first = a.status === "resolved" ? a.resolvedBy || "another agent" : null;
      a.status = "resolved";
      a.resolvedAt = new Date().toISOString();
      if (note) a.resolution = note;
      if (by) a.resolvedBy = by;
      persist();
      log(`resolved: #${a.number} ${a.comment}${note ? "  — " + note : ""}`);
      return first ? "already" : true;
    },
    async remove(id) {
      const before = db.annotations.length;
      // Delete exactly the one resolved, by id. Filtering on the number would have removed that
      // number from every page at once now that numbering is per page.
      const gone = findAnnotation(db, id);
      if (gone) { db.annotations = db.annotations.filter((x) => x.id !== gone.id); taken.delete(gone.id); }
      persist();
      if (gone) log(`removed: #${gone.number} ${gone.comment}`);
      return db.annotations.length < before;
    },
    async clear() {
      const n = db.annotations.length;
      db = { nextNumber: 1, annotations: [] };
      taken.clear();
      persist();
      log(`cleared ${n} annotation${n === 1 ? "" : "s"}`);
    },
    waitForNext(timeoutMs) {
      return new Promise((resolve) => {
        const t = setTimeout(() => { events.off("added", on); resolve(null); }, timeoutMs);
        // Listeners run in registration order, so the first waiter claims the note and every other
        // one stays blocked for the NEXT one. A null payload (a restart) releases everybody.
        const on = (a) => {
          if (a) {
            if (taken.has(a.id)) return;
            if (taken.size > 500) taken.clear(); // ponytail: ids only matter while a waiter is live
            taken.add(a.id);
          }
          clearTimeout(t);
          events.off("added", on);
          resolve(a);
        };
        events.on("added", on);
      });
    },
    // Give a just-arrived annotation a moment for its screenshot to land before handing it to an agent.
    waitForScreenshot(id, timeoutMs = 2500) {
      const a = find(id);
      if (!a || a.screenshot || a.screenshotSkipped) return Promise.resolve(a);
      return new Promise((resolve) => {
        const t = setTimeout(() => { events.off("screenshot", on); resolve(find(id)); }, timeoutMs);
        const on = (x) => {
          if (x.id !== a.id) return;
          clearTimeout(t);
          events.off("screenshot", on);
          resolve(x);
        };
        events.on("screenshot", on);
      });
    },
    waitForVersion(since, timeoutMs) {
      // `!==`, not `>`: after a restart our counter is back at 1 while the extension still asks
      // since=57. A client from a previous life is answered at once — with `>` it ate the full
      // 25s timeout on every poll until we climbed past its number, and pins looked frozen.
      if (version !== since) return Promise.resolve(version);
      return new Promise((resolve) => {
        const t = setTimeout(() => { events.off("version", on); resolve(version); }, timeoutMs);
        const on = (v) => { clearTimeout(t); events.off("version", on); resolve(v); };
        events.on("version", on);
      });
    },
    version: () => version,
    // Called by the MCP layer on every tool call, so the developer can see their agent working.
    // `who` is {name, version} from the MCP initialize handshake, when the client sent one.
    touch(action, id, label, who) {
      const name = who?.name || null;
      agent = { at: Date.now(), action, id: id || null, label: label || null, name, agentVersion: who?.version || null };
      agents.set(name || "?", agent);
      bump();
    },
    agent: () => (agent ? { ...agent, secondsAgo: Math.round((Date.now() - agent.at) / 1000) } : null),
    agents: () => [...agents.values()].map((a) => ({ ...a, secondsAgo: Math.round((Date.now() - a.at) / 1000) })),
  };

  function json(res, code, body) {
    res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
  }
  function readBody(req, limitBytes = 32 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > limitBytes) { reject(new Error("payload too large")); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null); }
        catch (e) { reject(e); }
      });
      req.on("error", reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;

    // Only the extension and local tools may talk to us. Web pages (any http/https Origin) are refused
    // so a malicious site can't read your annotations or inject instructions for your coding agent
    // (DNS rebinding can't help either: the Host must be loopback).
    const hostHeader = (req.headers.host || "").replace(/^\[|\]$/g, "").split(":")[0];
    if (!["127.0.0.1", "localhost", "::1"].includes(hostHeader)) return json(res, 403, { error: "loopback only" });
    const origin = req.headers.origin;
    // Only the extension (a *-extension:// origin) and origin-less local CLI tools. A localhost
    // origin is a web page too — the very dev site being annotated — so it is refused like any other.
    if (origin && !/^(chrome|moz|safari-web)-extension:\/\//.test(origin)) {
      return json(res, 403, { error: "origin not allowed" });
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version, accept",
        "access-control-max-age": "86400",
      });
      return res.end();
    }

    try {
      // ---- MCP over Streamable HTTP (stateless: one transport per request) ----
      if (p === "/mcp") {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const mcp = createMcpServer(api); // stateless: fresh server per request
        res.on("close", () => { transport.close(); mcp.close(); });
        await mcp.connect(transport);
        const body = req.method === "POST" ? await readBody(req) : undefined;
        return transport.handleRequest(req, res, body);
      }

      // `service` identifies us so the extension never mistakes another localhost server for the bridge.
      if (p === "/" || p === "/health") {
        return json(res, 200, {
          service: "pinpoint-bridge", ok: true, version: 1, port, project,
          pending: pending(db).length, dataFile: DATA_FILE, storeVersion: version, agent: api.agent(),
          agents: api.agents(), cliPath: CLI_PATH, restartable, pid: process.pid,
        });
      }

      // Long-poll: resolves as soon as anything changes, so pins update without a reload.
      // presence reported by the stdio MCP server, which runs in its own process
      if (p === "/agent" && req.method === "POST") {
        let b = {};
        try { b = (await readBody(req)) || {}; } catch {}
        api.touch(b.action, b.id, b.label, b.who);
        return json(res, 200, { ok: true });
      }

      // Restart in place, so the browser can pick up a new build of the bridge without a terminal.
      if (p === "/restart" && req.method === "POST") {
        if (!restartable) return json(res, 501, { error: "this bridge was not started as its own process" });
        json(res, 200, { ok: true, restarting: true, port });
        setTimeout(restart, 50); // let the response flush before the socket goes
        return;
      }

      if (p === "/events") {
        const since = Number(url.searchParams.get("since") || 0);
        const v = await api.waitForVersion(since, Math.min(Number(url.searchParams.get("timeout") || 25000), 60000));
        return json(res, 200, { version: v, changed: v > since });
      }

      if (p === "/annotations" && req.method === "GET") {
        const status = url.searchParams.get("status") || "all";
        const u = url.searchParams.get("url");
        const items = db.annotations.filter((a) => (status === "all" || a.status === status) && (!u || a.page.url.split("#")[0] === u));
        const withImages = url.searchParams.get("images") === "1";
        return json(res, 200, { version, agent: api.agent(), annotations: withImages ? items : items.map(({ screenshot, ...a }) => ({ ...a, hasScreenshot: !!screenshot })) });
      }

      if (p === "/annotations" && req.method === "POST") {
        let a;
        try { a = await readBody(req); } catch (e) { return json(res, 400, { error: e.message === "payload too large" ? "payload too large" : "invalid JSON" }); }
        if (!a || !a.comment || !a.element?.selector) return json(res, 400, { error: "comment and element.selector required" });
        const saved = await api.add(a);
        return json(res, 201, { ok: true, id: saved.id, number: saved.number });
      }

      if (p === "/annotations" && req.method === "DELETE") {
        await api.clear();
        return json(res, 200, { ok: true });
      }

      if (p === "/annotations/wait") {
        const a = await api.waitForNext(Number(url.searchParams.get("timeout") || 120000));
        return json(res, 200, { annotation: a ? await api.waitForScreenshot(a.id) : null });
      }

      const m = p.match(/^\/annotations\/([^/]+)(\/resolve|\/screenshot|\/notified)?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (req.method === "DELETE") return json(res, 200, { ok: await api.remove(id) });
        if (req.method === "POST" && m[2] === "/resolve") {
          let body = {};
          try { body = (await readBody(req)) || {}; } catch {}
          return json(res, 200, { ok: await api.resolve(id, body.note, body.by) });
        }
          if (req.method === "POST" && m[2] === "/notified") {
          const a = find(id);
          if (a) { a.notifiedAt = new Date().toISOString(); save(db); }
          return json(res, 200, { ok: !!a });
        }
      if ((req.method === "PUT" || req.method === "POST") && m[2] === "/screenshot") {
          let body;
          try { body = await readBody(req); } catch (e) { return json(res, 400, { error: String(e.message) }); }
          if (!body?.base64 && !body?.skipped) return json(res, 400, { error: "base64 or skipped required" });
          return json(res, 200, { ok: await api.attachScreenshot(id, body) });
        }
        if (req.method === "GET") {
          const a = find(id);
          return a ? json(res, 200, { annotation: a }) : json(res, 404, { error: "not found" });
        }
      }

      if (p === "/pending.md") {
        res.writeHead(200, { "content-type": "text/markdown", "access-control-allow-origin": "*" });
        return res.end(pendingMarkdown(db, { channel: "file", cliPath: CLI_PATH }));
      }

      json(res, 404, { error: "not found" });
    } catch (e) {
      log("error:", e);
      if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
    }
  });

  function restart() {
    bump();                        // release /events waiters with a normal 200
    events.emit("added", null);    // release /annotations/wait the way a timeout does
    server.closeAllConnections?.(); // without this, close() waits out every 25s long-poll
    server.close(() => {
      // Close BEFORE spawning or the replacement hits EADDRINUSE against us. stdio is inherited on
      // purpose: started from a terminal, Ctrl-C must still work on the new one.
      spawn(process.execPath, process.argv.slice(1), { stdio: "inherit", cwd: process.cwd() }).unref();
      process.exit(0);
    });
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      log(`listening on http://127.0.0.1:${port}  (MCP: http://127.0.0.1:${port}/mcp)`);
      if (project) { log(`mirroring pending annotations to ${path.join(project, ".pinpoint")}/`); mirrorToProject(); }
      resolve({ server, api, port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
