// Bridge daemon, CLI and MCP tests. Run: node --test bridge.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import { StdioClientTransport } from "../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, "../bridge/cli.js");
const PORT = 7399;
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pp-home-"));
const PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), "pp-proj-"));
const ENV = { ...process.env, PINPOINT_HOME: HOME };

let daemon;
async function startDaemon(extra = []) {
  daemon = spawn("node", [CLI, "--port", String(PORT), "--project", PROJECT, ...extra], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stderr.on("data", () => {});
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + "/health"); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("daemon did not start");
}
async function stopDaemon() {
  if (!daemon) return;
  daemon.kill();
  await new Promise((r) => daemon.once("exit", r));
  daemon = null;
}

function sample(over = {}) {
  return {
    id: Math.random().toString(36).slice(2, 10),
    comment: "make it purple",
    page: { url: "http://localhost:3000/page", title: "T", viewport: { width: 1200, height: 800, dpr: 2 }, scroll: { x: 0, y: 0 } },
    element: { tag: "button", id: "cta", classes: ["cta"], selector: "#cta", domPath: "body > main > button#cta", text: "Buy", outerHTML: "<button id=cta>Buy</button>", attributes: {}, rect: { x: 1, y: 2, width: 100, height: 40 }, styles: { color: "rgb(0,0,0)" } },
    source: { framework: "react", components: ["Hero", "App"], file: "src/Hero.tsx", line: 12, column: null, attributes: {} },
    screenshot: { base64: Buffer.from("png").toString("base64"), width: 10, height: 10 },
    ...over,
  };
}
const post = (body) => fetch(BASE + "/annotations", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const get = async (p) => (await fetch(BASE + p)).json();

before(() => startDaemon());
after(async () => { await stopDaemon(); fs.rmSync(HOME, { recursive: true, force: true }); fs.rmSync(PROJECT, { recursive: true, force: true }); });

test("health reports port, project, pending count, data file", async () => {
  const h = await get("/health");
  assert.equal(h.ok, true); assert.equal(h.port, PORT); assert.equal(h.project, PROJECT); assert.equal(h.pending, 0);
  assert.ok(h.dataFile.startsWith(HOME));
});

test("POST validation: missing comment / selector / malformed JSON → 400", async () => {
  assert.equal((await post(sample({ comment: "" }))).status, 400);
  assert.equal((await post({ comment: "x" })).status, 400);
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post("")).status, 400);
});

test("POST assigns sequential numbers and persists; GET strips screenshots unless images=1", async () => {
  const a = await (await post(sample({ id: "aaaa0001" }))).json();
  const b = await (await post(sample({ id: "bbbb0002", page: { ...sample().page, url: "http://localhost:3000/other" } }))).json();
  assert.equal(a.number, 1); assert.equal(b.number, 2);
  const { annotations } = await get("/annotations");
  assert.equal(annotations.length, 2);
  assert.equal(annotations[0].screenshot, undefined);
  assert.equal(annotations[0].hasScreenshot, true);
  const withImg = await get("/annotations?images=1");
  assert.ok(withImg.annotations[0].screenshot.base64);
  const onDisk = JSON.parse(fs.readFileSync(path.join(HOME, "annotations.json"), "utf8"));
  assert.equal(onDisk.annotations.length, 2);
  assert.equal(onDisk.nextNumber, 3);
});

test("GET filters by status and exact url (fragment ignored)", async () => {
  assert.equal((await get("/annotations?url=" + encodeURIComponent("http://localhost:3000/page"))).annotations.length, 1);
  assert.equal((await get("/annotations?url=" + encodeURIComponent("http://localhost:3000/nope"))).annotations.length, 0);
  assert.equal((await get("/annotations?status=resolved")).annotations.length, 0);
});

test("project mirror: pending.md and pending.json written, screenshots omitted from json", async () => {
  const md = fs.readFileSync(path.join(PROJECT, ".pinpoint/pending.md"), "utf8");
  assert.match(md, /# 2 pending UI change requests/);
  assert.match(md, /Component chain \(react\): Hero ← App/);
  assert.match(md, /Source file: src\/Hero.tsx:12/);
  const js = JSON.parse(fs.readFileSync(path.join(PROJECT, ".pinpoint/pending.json"), "utf8"));
  assert.equal(js[0].screenshot.base64, undefined, "no base64 blob in the repo mirror");
  assert.match(js[0].screenshot.note, /not included/);
});

test("GET /annotations/:id by id and by number; 404 for unknown", async () => {
  assert.equal((await get("/annotations/aaaa0001")).annotation.number, 1);
  assert.equal((await get("/annotations/2")).annotation.id, "bbbb0002");
  assert.equal((await fetch(BASE + "/annotations/zzz")).status, 404);
});

test("resolve by id, with note; resolved items leave pending views", async () => {
  const r = await (await fetch(BASE + "/annotations/aaaa0001/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "changed Hero.tsx" }) })).json();
  assert.equal(r.ok, true);
  const a = (await get("/annotations/aaaa0001")).annotation;
  assert.equal(a.status, "resolved"); assert.equal(a.resolution, "changed Hero.tsx"); assert.ok(a.resolvedAt);
  assert.equal((await get("/annotations?status=pending")).annotations.length, 1);
  assert.equal((await get("/health")).pending, 1);
  assert.match(fs.readFileSync(path.join(PROJECT, ".pinpoint/pending.md"), "utf8"), /# 1 pending/);
  const r2 = await (await fetch(BASE + "/annotations/nope/resolve", { method: "POST" })).json();
  assert.equal(r2.ok, false);
});

test("DELETE one by number; DELETE all resets numbering", async () => {
  assert.equal((await (await fetch(BASE + "/annotations/2", { method: "DELETE" })).json()).ok, true);
  assert.equal((await get("/annotations?status=all")).annotations.length, 1);
  await fetch(BASE + "/annotations", { method: "DELETE" });
  assert.equal((await get("/annotations?status=all")).annotations.length, 0);
  const n = await (await post(sample())).json();
  assert.equal(n.number, 1, "numbering restarts after clear");
  assert.match(fs.readFileSync(path.join(PROJECT, ".pinpoint/pending.md"), "utf8"), /# 1 pending/);
  await fetch(BASE + "/annotations", { method: "DELETE" });
  assert.match(fs.readFileSync(path.join(PROJECT, ".pinpoint/pending.md"), "utf8"), /No pending/);
});

test("long-poll /annotations/wait resolves on next POST and null on timeout", async () => {
  const t0 = Date.now();
  const timedOut = await get("/annotations/wait?timeout=300");
  assert.equal(timedOut.annotation, null);
  assert.ok(Date.now() - t0 >= 280);
  const waiting = get("/annotations/wait?timeout=5000");
  await new Promise((r) => setTimeout(r, 100));
  await post(sample({ id: "wait0001", comment: "waited for" }));
  const got = await waiting;
  assert.equal(got.annotation.id, "wait0001");
});

test("/pending.md serves markdown; CORS preflight ok; non-loopback Host refused", async () => {
  const r = await fetch(BASE + "/pending.md");
  assert.equal(r.headers.get("content-type"), "text/markdown");
  assert.match(await r.text(), /waited for/);
  const o = await fetch(BASE + "/annotations", { method: "OPTIONS" });
  assert.equal(o.status, 204);
  assert.equal(o.headers.get("access-control-allow-origin"), "*");
  const bad = await new Promise((res) => http.get({ host: "127.0.0.1", port: PORT, path: "/health", headers: { host: "evil.example" } }, (r) => res(r.statusCode)));
  assert.equal(bad, 403, "non-loopback Host refused");
  const web = await fetch(BASE + "/annotations", { headers: { origin: "https://evil.example" } });
  assert.equal(web.status, 403, "web page origin refused");
  const ext = await fetch(BASE + "/annotations", { headers: { origin: "chrome-extension://abcdefghijklmnop" } });
  assert.equal(ext.status, 200, "extension origin allowed");
  const webPre = await fetch(BASE + "/annotations", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
  assert.equal(webPre.status, 403, "web preflight refused");
  // The dev site being annotated is served from localhost. It is still a web page, so it must not
  // be able to read the screenshots, delete notes, or POST instructions the hook feeds to an agent.
  const localPage = await fetch(BASE + "/annotations", { headers: { origin: "http://localhost:3000" } });
  assert.equal(localPage.status, 403, "a localhost page origin is refused like any other web page");
  assert.equal((await fetch(BASE + "/whatever")).status, 404);
});

test("large payload (1.5 MB screenshot) accepted", async () => {
  const big = sample({ id: "bigbig01", screenshot: { base64: "A".repeat(1_500_000), width: 1200, height: 900 } });
  assert.equal((await post(big)).status, 201);
  const back = await get("/annotations/bigbig01");
  assert.equal(back.annotation.screenshot.base64.length, 1_500_000);
});

test("annotations survive daemon restart; port-in-use exits with clear error", async () => {
  const before = (await get("/annotations?status=all")).annotations.length;
  const dup = spawn("node", [CLI, "--port", String(PORT)], { env: ENV });
  let err = "";
  dup.stderr.on("data", (d) => (err += d));
  const code = await new Promise((r) => dup.once("exit", r));
  assert.equal(code, 1); assert.match(err, /already in use/);
  await stopDaemon();
  await startDaemon();
  assert.equal((await get("/annotations?status=all")).annotations.length, before);
});

test("CLI print (via daemon) and print --consume; clear", async () => {
  const run = (args) => new Promise((res) => { const p = spawn("node", [CLI, ...args, "--port", String(PORT)], { env: ENV }); let out = ""; p.stdout.on("data", (d) => (out += d)); p.once("exit", (c) => res({ out, c })); });
  let { out } = await run(["print"]);
  assert.match(out, /pending UI change request/);
  ({ out } = await run(["print", "--consume"]));
  assert.match(out, /pending UI change request/);
  assert.equal((await get("/annotations?status=pending")).annotations.length, 0);
  await post(sample());
  const { c } = await run(["clear"]);
  assert.equal(c, 0);
  assert.equal((await get("/annotations?status=all")).annotations.length, 0);
});

// ---------- MCP ----------
async function httpClient() {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp")));
  return c;
}
async function stdioClient() {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: [CLI, "mcp", "--port", String(PORT)], env: ENV }));
  return c;
}
const text = (r) => r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

for (const [name, mk] of [["http", httpClient], ["stdio", stdioClient]]) {
  test(`MCP over ${name}: tool list, resources, all tools`, async () => {
    await fetch(BASE + "/annotations", { method: "DELETE" });
    await post(sample({ id: "mcp00001", comment: "first" }));
    await post(sample({ id: "mcp00002", comment: "second", page: { ...sample().page, url: "http://other.test/" }, screenshot: null }));
    const c = await mk();
    const tools = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["clear_annotations", "get_annotation", "get_pending_annotations", "list_annotations", "resolve_annotation", "wait_for_annotation"]);
    const res = await c.listResources();
    assert.ok(res.resources.some((r) => r.uri === "pinpoint://pending"));
    const rr = await c.readResource({ uri: "pinpoint://pending" });
    assert.match(rr.contents[0].text, /# 2 pending/);

    const all = await c.callTool({ name: "get_pending_annotations", arguments: {} });
    assert.match(text(all), /### #1 — first/); assert.match(text(all), /### #2 — second/);
    assert.equal(all.content.filter((b) => b.type === "image").length, 1, "only the annotation with a screenshot yields an image block");
    assert.equal(all.content.find((b) => b.type === "image").mimeType, "image/png");

    const filtered = await c.callTool({ name: "get_pending_annotations", arguments: { url: "http://other.test" } });
    assert.doesNotMatch(text(filtered), /### #1 — first/); assert.match(text(filtered), /second/);

    const byNum = await c.callTool({ name: "get_annotation", arguments: { id: "2" } });
    assert.match(text(byNum), /second/);
    const missing = await c.callTool({ name: "get_annotation", arguments: { id: "nope" } });
    assert.equal(missing.isError, true);

    const resolved = await c.callTool({ name: "resolve_annotation", arguments: { id: "mcp00001", note: "done" } });
    assert.match(text(resolved), /Resolved/);
    assert.match(text(await c.callTool({ name: "list_annotations", arguments: {} })), /^#2 \[mcp00002\] second/m);
    assert.doesNotMatch(text(await c.callTool({ name: "list_annotations", arguments: {} })), /\] first/);
    assert.match(text(await c.callTool({ name: "list_annotations", arguments: { status: "all" } })), /first/);
    const bad = await c.callTool({ name: "resolve_annotation", arguments: { id: "zzz" } });
    assert.equal(bad.isError, true);

    const waiting = c.callTool({ name: "wait_for_annotation", arguments: { timeoutSeconds: 5 } });
    await new Promise((r) => setTimeout(r, 150));
    await post(sample({ id: "mcp00003", comment: "third" }));
    assert.match(text(await waiting), /third/);
    const to = await c.callTool({ name: "wait_for_annotation", arguments: { timeoutSeconds: 1 } });
    assert.match(text(to), /Timed out/);

    await c.callTool({ name: "clear_annotations", arguments: {} });
    assert.match(text(await c.callTool({ name: "list_annotations", arguments: { status: "all" } })), /No all annotations|No .* annotations/);
    await c.close();
  });
}

test("MCP http: 20 concurrent stateless requests all succeed", async () => {
  await post(sample({ id: "conc0001" }));
  const clients = await Promise.all(Array.from({ length: 20 }, httpClient));
  const results = await Promise.all(clients.map((c) => c.callTool({ name: "list_annotations", arguments: {} })));
  results.forEach((r) => assert.match(text(r), /conc0001/));
  await Promise.all(clients.map((c) => c.close()));
});

test("stdio MCP falls back to the JSON file when the daemon is down (reads and resolves)", async () => {
  await stopDaemon();
  const c = await stdioClient();
  const list = text(await c.callTool({ name: "list_annotations", arguments: {} }));
  assert.match(list, /conc0001/);
  assert.match(text(await c.callTool({ name: "resolve_annotation", arguments: { id: "conc0001" } })), /Resolved/);
  const to = await c.callTool({ name: "wait_for_annotation", arguments: { timeoutSeconds: 1 } });
  assert.match(text(to), /Timed out/);
  await c.close();
  const onDisk = JSON.parse(fs.readFileSync(path.join(HOME, "annotations.json"), "utf8"));
  assert.equal(onDisk.annotations.find((a) => a.id === "conc0001").status, "resolved");
  await startDaemon();
  assert.equal((await get("/annotations/conc0001")).annotation.status, "resolved", "daemon picks up file changes made while it was down");
});

test("corrupt annotations.json is tolerated (fresh store)", async () => {
  await stopDaemon();
  fs.writeFileSync(path.join(HOME, "annotations.json"), "{{{{");
  await startDaemon();
  assert.equal((await get("/annotations?status=all")).annotations.length, 0);
});

test("resolved annotations are pruned beyond PINPOINT_MAX_RESOLVED (pending never pruned)", async () => {
  await stopDaemon();
  const prev = ENV.PINPOINT_MAX_RESOLVED; ENV.PINPOINT_MAX_RESOLVED = "3";
  await fetch(BASE + "/annotations", { method: "DELETE" }).catch(() => {});
  await startDaemon();
  await fetch(BASE + "/annotations", { method: "DELETE" });
  for (let i = 0; i < 5; i++) { const { id } = await (await post(sample({ id: `r${i}00000`.slice(0, 8), comment: "old" }))).json(); await fetch(`${BASE}/annotations/${id}/resolve`, { method: "POST" }); }
  await post(sample({ id: "pend0001", comment: "keep me" }));
  await post(sample({ id: "pend0002", comment: "keep me too" }));
  const all = (await get("/annotations?status=all")).annotations;
  assert.equal(all.filter((a) => a.status === "resolved").length, 3);
  assert.equal(all.filter((a) => a.status === "pending").length, 2);
  assert.match(fs.readFileSync(path.join(PROJECT, ".pinpoint/pending.md"), "utf8"), /untrusted data/);
  if (prev === undefined) delete ENV.PINPOINT_MAX_RESOLVED; else ENV.PINPOINT_MAX_RESOLVED = prev;
});

// ================= regression tests for the v0.2 fixes =================

test("health identifies the service so another server on the port can't be mistaken for it", async () => {
  const h = await get("/health");
  assert.equal(h.service, "pinpoint-bridge");
  assert.ok(typeof h.storeVersion === "number");
  const root = await get("/");
  assert.equal(root.service, "pinpoint-bridge");
});

test("/events long-polls and resolves as soon as the store changes (Bug 1 plumbing)", async () => {
  await fetch(BASE + "/annotations", { method: "DELETE" });
  const v0 = (await get("/health")).storeVersion;
  const timedOut = await get(`/events?since=${v0}&timeout=250`);
  assert.equal(timedOut.changed, false);
  const waiting = get(`/events?since=${v0}&timeout=5000`);
  await new Promise((r) => setTimeout(r, 80));
  const { id } = await (await post(sample({ id: "evt00001" }))).json();
  const ev = await waiting;
  assert.equal(ev.changed, true);
  assert.ok(ev.version > v0);
  // resolving also bumps the version — that is what clears the pin in the browser
  const v1 = ev.version;
  const waiting2 = get(`/events?since=${v1}&timeout=5000`);
  await new Promise((r) => setTimeout(r, 50));
  await fetch(`${BASE}/annotations/${id}/resolve`, { method: "POST" });
  assert.equal((await waiting2).changed, true);
});

test("screenshot is attached after the fact (Bug 6): annotation exists without it, then gains it", async () => {
  await fetch(BASE + "/annotations", { method: "DELETE" });
  const r = await (await post(sample({ id: "shot0001", screenshot: null }))).json();
  assert.equal(r.ok, true);
  let a = (await get("/annotations/shot0001")).annotation;
  assert.equal(a.screenshot, null, "the comment is stored on its own");
  const png = { base64: Buffer.from("fake").toString("base64"), width: 20, height: 10 };
  const put = await (await fetch(`${BASE}/annotations/shot0001/screenshot`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(png) })).json();
  assert.equal(put.ok, true);
  a = (await get("/annotations/shot0001")).annotation;
  assert.equal(a.screenshot.width, 20);
  assert.equal((await (await fetch(`${BASE}/annotations/nope/screenshot`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(png) })).json()).ok, false);
  assert.equal((await fetch(`${BASE}/annotations/shot0001/screenshot`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
});

test("/annotations/wait waits for the screenshot to land before returning", async () => {
  await fetch(BASE + "/annotations", { method: "DELETE" });
  const waiting = get("/annotations/wait?timeout=6000");
  await new Promise((r) => setTimeout(r, 60));
  await post(sample({ id: "late0001", screenshot: null }));
  await new Promise((r) => setTimeout(r, 120));
  await fetch(`${BASE}/annotations/late0001/screenshot`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ base64: "AA==", width: 5, height: 5 }) });
  const { annotation } = await waiting;
  assert.equal(annotation.id, "late0001");
  assert.ok(annotation.screenshot, "the agent gets the picture, not a placeholder");
});

test("file output is honest: no phantom attachment, and a runnable resolve command (Bug 7)", async () => {
  const md = fs.readFileSync(path.join(PROJECT, ".pinpoint/pending.md"), "utf8");
  assert.doesNotMatch(md, /attached as an image below/, "file readers are not told an image is attached");
  assert.match(md, /stored in the bridge/);
  assert.match(md, /node .*cli\.js resolve <id>/, "tells a file-based agent how to finish");
  const js = JSON.parse(fs.readFileSync(path.join(PROJECT, ".pinpoint/pending.json"), "utf8"));
  assert.match(js[0].screenshot.note, /MCP/);
  assert.ok(fs.existsSync(path.join(PROJECT, ".pinpoint/.gitignore")), "mirror keeps itself out of git");
});

test("CLI: --help/-h/help print usage and never start a daemon (Bug 3)", async () => {
  const run = (args) => new Promise((res) => {
    const p = spawn("node", [CLI, ...args], { env: ENV });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { p.kill(); res({ out, err, code: "HUNG" }); }, 4000);
    p.once("exit", (c) => { clearTimeout(t); res({ out, err, code: c }); });
  });
  for (const a of [["--help"], ["-h"], ["help"]]) {
    const r = await run(a);
    assert.equal(r.code, 0, `${a} exited ${r.code}`);
    assert.match(r.out, /Usage/);
    assert.match(r.out, /install-hooks/);
  }
  const bad = await run(["nonsense"]);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /Usage/);
});

test("CLI: port-in-use error names --port (friction fix)", async () => {
  const p = spawn("node", [CLI, "--port", String(PORT)], { env: ENV });
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  assert.equal(await new Promise((r) => p.once("exit", r)), 1);
  assert.match(err, /--port/);
});

test("CLI: resolve <id> works against the daemon and against the file when it is down", async () => {
  const run = (args) => new Promise((res) => {
    const p = spawn("node", [CLI, ...args, "--port", String(PORT)], { env: ENV });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.once("exit", (c) => res({ err, code: c }));
  });
  await fetch(BASE + "/annotations", { method: "DELETE" });
  await post(sample({ id: "cli00001" }));
  await post(sample({ id: "cli00002" }));
  const r = await run(["resolve", "cli00001"]);
  assert.equal(r.code, 0);
  assert.equal((await get("/annotations/cli00001")).annotation.status, "resolved");
  const miss = await run(["resolve", "nope"]);
  assert.equal(miss.code, 1);
  await stopDaemon();
  const offline = await run(["resolve", "2"]);        // by pin number, no daemon
  assert.equal(offline.code, 0);
  const db = JSON.parse(fs.readFileSync(path.join(HOME, "annotations.json"), "utf8"));
  assert.equal(db.annotations.find((a) => a.id === "cli00002").status, "resolved");
  await startDaemon();
});

test("CLI: status reports running / not running", async () => {
  const run = (args) => new Promise((res) => {
    const p = spawn("node", [CLI, ...args, "--port", String(PORT)], { env: ENV });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.once("exit", (c) => res({ out, code: c }));
  });
  const on = await run(["status"]);
  assert.equal(on.code, 0);
  assert.match(on.out, /bridge running on :/);
  await stopDaemon();
  const off = await run(["status"]);
  assert.equal(off.code, 1);
  assert.match(off.out, /NOT running/);
  await startDaemon();
});

test("print --hook is silent when nothing is pending and self-describing when something is", async () => {
  const run = () => new Promise((res) => {
    const p = spawn("node", [CLI, "print", "--hook", "--port", String(PORT)], { env: ENV });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.once("exit", (c) => res({ out, code: c }));
  });
  await fetch(BASE + "/annotations", { method: "DELETE" });
  const quiet = await run();
  assert.equal(quiet.out, "", "adds nothing to a normal Claude Code prompt");
  assert.equal(quiet.code, 0);
  await post(sample({ id: "hook0001", comment: "tighten the header" }));
  const loud = await run();
  assert.match(loud.out, /<pinpoint count="1" new="1">/);
  assert.match(loud.out, /tighten the header/);
  assert.match(loud.out, /resolve/);
  assert.match(loud.out, /Never ignore this block silently/);
  assert.match(loud.out, /<\/pinpoint>/);
  // asked a second time it does not re-dump everything: it reminds, briefly
  const again = await run();
  assert.match(again.out, /<pinpoint count="1" new="0">/);
  assert.doesNotMatch(again.out, /Computed styles/);
  assert.match(again.out, /still waiting/);
  assert.ok(again.out.length < loud.out.length / 2, "the reminder is much shorter than the first delivery");
});

test("install-hooks writes Claude Code settings, is idempotent and preserves other hooks", async () => {
  const { installHooks, hookCommand } = await import("../bridge/hooks.js");
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "pp-hooks-"));
  const settingsFile = path.join(proj, ".claude/settings.json");

  const r1 = installHooks(proj, CLI, {});
  assert.equal(r1.file, settingsFile);
  let s = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].command, hookCommand(CLI, {}));
  assert.match(s.hooks.SessionStart[0].hooks[0].command, /print --hook/);

  // a user's own hook and unrelated settings must survive
  s.permissions = { allow: ["Bash(npm test)"] };
  s.hooks.UserPromptSubmit.unshift({ hooks: [{ type: "command", command: "echo mine" }] });
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));

  const r2 = installHooks(proj, CLI, { port: 7444 });
  assert.match(r2.message, /updated/);
  s = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.deepEqual(s.permissions, { allow: ["Bash(npm test)"] });
  assert.equal(s.hooks.UserPromptSubmit.length, 2, "no duplicate pinpoint entry");
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].command, "echo mine");
  assert.match(s.hooks.UserPromptSubmit[1].hooks[0].command, /--port 7444/);

  fs.writeFileSync(settingsFile, "{ broken");
  assert.throws(() => installHooks(proj, CLI, {}), /not valid JSON/);
  fs.rmSync(proj, { recursive: true, force: true });
});

test("oversized payload is rejected rather than eating memory", async () => {
  const huge = JSON.stringify(sample({ screenshot: { base64: "A".repeat(40 * 1024 * 1024), width: 1, height: 1 } }));
  const res = await post(huge).catch((e) => ({ status: 0, err: e }));
  assert.ok(res.status === 400 || res.status === 0, `got ${res.status}`);
  assert.equal((await get("/health")).ok, true, "daemon survives");
});

test("CLI: a flag before the subcommand runs that subcommand, not the daemon", async () => {
  // `node cli.js --port 7332 status` used to see a leading "-" and fall through to "start",
  // leaving a long-running server on the terminal of someone who only asked a question.
  const run = (args) => new Promise((res) => {
    const p = spawn("node", [CLI, ...args], { env: ENV });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { p.kill(); res({ out, err, code: "HUNG" }); }, 6000);
    p.once("exit", (c) => { clearTimeout(t); res({ out, err, code: c }); });
  });
  const r = await run(["--port", "7332", "status"]);
  assert.notEqual(r.code, "HUNG", "flag-first status must not start a daemon");
  assert.match(r.out, /bridge NOT running on :7332/);
});

test("hooks: a path with a space stays quoted, and unrelated hooks survive", async () => {
  const { hookCommand, installHooks } = await import("../bridge/hooks.js");

  // Unquoted, the shell splits this into `node /Users/me/My` and every prompt fails.
  const spacey = "/Users/me/My Projects/pinpoint/bridge/cli.js";
  assert.ok(hookCommand(spacey, {}).includes(`"${spacey}"`), "install path must stay quoted");

  // Ownership used to be a substring test for "pinpoint", so a user's own hook that merely
  // mentioned pinpoint — or a repo living in a pinpoint/ folder — was silently deleted.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pp-hooks-"));
  const settings = path.join(repo, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const mine = { hooks: [{ type: "command", command: "echo my repo lives in ~/dev/pinpoint" }] };
  fs.writeFileSync(settings, JSON.stringify({ hooks: { UserPromptSubmit: [mine] } }, null, 2));

  installHooks(repo, CLI, {});
  const after1 = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.ok(
    after1.hooks.UserPromptSubmit.some((e) => JSON.stringify(e) === JSON.stringify(mine)),
    "an unrelated hook mentioning pinpoint must survive"
  );

  // Still idempotent: re-running updates our entry rather than appending a second one.
  installHooks(repo, CLI, {});
  const after2 = JSON.parse(fs.readFileSync(settings, "utf8"));
  const ours = after2.hooks.UserPromptSubmit.filter((e) => JSON.stringify(e).includes("print --hook"));
  assert.equal(ours.length, 1, "re-running must not duplicate our hook");
  assert.equal(after2.hooks.UserPromptSubmit.length, 2, "user hook + ours");
});
