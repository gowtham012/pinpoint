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
  // Numbers are per page: b is on a different url, so it is that page's first note, not the
  // store's second. A single global counter made the first note on a new site read as "#14".
  assert.equal(a.number, 1); assert.equal(b.number, 1);
  const { annotations } = await get("/annotations");
  assert.equal(annotations.length, 2);
  assert.equal(annotations[0].screenshot, undefined);
  assert.equal(annotations[0].hasScreenshot, true);
  const withImg = await get("/annotations?images=1");
  assert.ok(withImg.annotations[0].screenshot.base64);
  const onDisk = JSON.parse(fs.readFileSync(path.join(HOME, "annotations.json"), "utf8"));
  assert.equal(onDisk.annotations.length, 2);
  assert.equal(onDisk.annotations.filter((x) => x.number === 1).length, 2, "one #1 per page");
});

test("numbers are per page, and a number never resolves someone else's note", async () => {
  // Deliberately does NOT clear the store: this suite is stateful and ordered, and later tests
  // depend on what earlier ones posted. Fresh urls are enough — per-page numbering means a new
  // page starts at 1 no matter what else is in there, which is the property under test.
  const page = (u) => ({ ...sample().page, url: u });
  const A = "http://localhost:3000/per-page-a", B = "http://localhost:3000/per-page-b";
  assert.equal((await (await post(sample({ id: "pa000001", comment: "a1", page: page(A) }))).json()).number, 1);
  assert.equal((await (await post(sample({ id: "pa000002", comment: "a2", page: page(A) }))).json()).number, 2);
  // a different page starts again at 1 rather than continuing the store's global count
  assert.equal((await (await post(sample({ id: "pb000001", comment: "b1", page: page(B) }))).json()).number, 1);

  // "1" now exists on more than one page, so it must not silently pick one
  assert.equal((await fetch(BASE + "/annotations/1")).status, 404, "an ambiguous number resolves nothing");
  // ids stay unique and always work
  assert.equal((await get("/annotations/pb000001")).annotation.comment, "b1");

  // and deleting by an ambiguous number must not wipe that number from every page
  assert.equal((await (await fetch(BASE + "/annotations/1", { method: "DELETE" })).json()).ok, false);
  const all = (await get("/annotations?status=all")).annotations.map((x) => x.id);
  for (const id of ["pa000001", "pa000002", "pb000001"]) assert.ok(all.includes(id), `${id} survived`);

  // clean up only what this test added, so the suite's own state is untouched
  for (const id of ["pa000001", "pa000002", "pb000001"]) await fetch(`${BASE}/annotations/${id}`, { method: "DELETE" });
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

test("GET by id always; by number only while it is unambiguous", async () => {
  assert.equal((await get("/annotations/aaaa0001")).annotation.number, 1);
  // numbering is per page, so the second annotation is its own page's #1, not the store's #2
  assert.equal((await get("/annotations/bbbb0002")).annotation.number, 1);
  // which means "1" now names two different notes, and must resolve neither
  assert.equal((await fetch(BASE + "/annotations/1")).status, 404, "ambiguous number picks nothing");
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

test("DELETE one by id; DELETE all resets numbering", async () => {
  // by id, not by number: the same number now exists on more than one page.
  assert.equal((await (await fetch(BASE + "/annotations/bbbb0002", { method: "DELETE" })).json()).ok, true);
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
    assert.deepEqual(tools, ["clear_annotations", "get_annotation", "get_pending_annotations", "list_annotations", "recheck_annotation", "resolve_annotation", "wait_for_annotation"]);
    const res = await c.listResources();
    assert.ok(res.resources.some((r) => r.uri === "pinpoint://pending"));
    const rr = await c.readResource({ uri: "pinpoint://pending" });
    assert.match(rr.contents[0].text, /# 2 pending/);

    const all = await c.callTool({ name: "get_pending_annotations", arguments: {} });
    // "second" is on a different page, so per-page numbering makes it that page's #1 — not the
    // store's #2. Both notes are #1, each on its own page.
    assert.match(text(all), /### #1 — first/); assert.match(text(all), /### #1 — second/);
    assert.equal(all.content.filter((b) => b.type === "image").length, 1, "only the annotation with a screenshot yields an image block");
    assert.equal(all.content.find((b) => b.type === "image").mimeType, "image/png");

    const filtered = await c.callTool({ name: "get_pending_annotations", arguments: { url: "http://other.test" } });
    assert.doesNotMatch(text(filtered), /### #1 — first/); assert.match(text(filtered), /second/);

    // ids always work; a number only while it names one note. Both of these are their page's #1,
    // so "1" names two and must resolve neither — an agent is told to use the id for this reason.
    assert.match(text(await c.callTool({ name: "get_annotation", arguments: { id: "mcp00002" } })), /second/);
    assert.equal((await c.callTool({ name: "get_annotation", arguments: { id: "1" } })).isError, true);
    const missing = await c.callTool({ name: "get_annotation", arguments: { id: "nope" } });
    assert.equal(missing.isError, true);

    const resolved = await c.callTool({ name: "resolve_annotation", arguments: { id: "mcp00001", note: "done" } });
    assert.match(text(resolved), /Resolved/);
    assert.match(text(await c.callTool({ name: "list_annotations", arguments: {} })), /^#1 \[mcp00002\] second/m);
    assert.doesNotMatch(text(await c.callTool({ name: "list_annotations", arguments: {} })), /\] first/);
    assert.match(text(await c.callTool({ name: "list_annotations", arguments: { status: "all" } })), /first/);
    // note is required now — pass one so this still tests an unknown id, not a bad schema
    const bad = await c.callTool({ name: "resolve_annotation", arguments: { id: "zzz", note: "n/a" } });
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

test("resolve_annotation demands a real reply, because the developer reads it", async () => {
  // Resolving used to take an optional note, so agents skipped it and every finished annotation
  // came back with resolution: null — leaving the developer with a vanished pin and no idea what
  // had been done. The note is the reply shown in their browser, so it is required.
  await post(sample({ id: "reply001", comment: "make this bigger" }));
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp")));

  const tool = (await c.listTools()).tools.find((t) => t.name === "resolve_annotation");
  assert.ok(!(tool.inputSchema.required || []).includes("note") === false, "note must be a required input");
  assert.match(JSON.stringify(tool.description), /what you actually changed|what changed and where/i,
    "the description has to ask for something specific, not just a flag");

  const ok = await c.callTool({ name: "resolve_annotation", arguments: { id: "reply001", note: "Bumped to 40px in Hero.tsx:12" } });
  assert.match(JSON.stringify(ok.content), /Resolved/);
  const [done] = (await get("/annotations?status=resolved")).annotations.filter((a) => a.id === "reply001");
  assert.equal(done.resolution, "Bumped to 40px in Hero.tsx:12", "the reply is stored for the browser to show");
  await c.close();
});

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
  assert.match(text(await c.callTool({ name: "resolve_annotation", arguments: { id: "conc0001", note: "changed it" } })), /Resolved/);
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

  // The command is written into settings.json, so what matters is the string Claude Code parses
  // back out. JSON-escaping the path (rather than plain-quoting it) survived this round trip as
  // C:\\Users\\... — doubled separators, on the platform least able to shrug them off.
  for (const cliPath of [
    "C:\\Users\\dev\\pinpoint\\bridge\\cli.js",
    "C:\\Users\\My Projects\\pinpoint\\bridge\\cli.js",
    "/home/dev/pinpoint/bridge/cli.js",
  ]) {
    const command = hookCommand(cliPath, {});
    const afterRoundTrip = JSON.parse(JSON.stringify({ command })).command;
    assert.equal(afterRoundTrip, `node "${cliPath}" print --hook`, `path mangled for ${cliPath}`);
  }

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

// ---------------------------------------------------------------------------
// Starting the bridge from the browser, and telling agents apart.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const postJson = async (p, body) => (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

test("/health names the bridge's own launch command, so the extension can print a real one", async () => {
  const h = await (await fetch(BASE + "/health")).json();
  assert.ok(h.cliPath, "health must carry cliPath");
  assert.ok(fs.existsSync(h.cliPath), `${h.cliPath} should exist`);
  assert.equal(path.basename(h.cliPath), "cli.js");
  assert.equal(h.restartable, true, "a daemon started by cli.js owns its process");
  assert.ok(h.pid > 0);
});

test("install-native-host: writes one manifest per detected browser, unions, uninstalls", async () => {
  const { installNativeHost, extensionId, HOST_NAME } = await import("../bridge/native-host.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-nmh-"));
  // Detection is "the browser's own directory exists" — Chrome and Brave here, Edge deliberately not.
  fs.mkdirSync(path.join(root, "Google/Chrome"), { recursive: true });
  fs.mkdirSync(path.join(root, "BraveSoftware/Brave-Browser"), { recursive: true });
  const wrapperPath = path.join(root, "pinpoint-host.sh");
  const opts = { root, platform: "darwin", wrapperPath, home: HOME };

  const r = installNativeHost(opts);
  assert.equal(r.files.length, 2, "Chrome and Brave, not Edge");
  assert.ok(!fs.existsSync(path.join(root, "Microsoft Edge")), "must never create a browser directory");

  const manifestKey = JSON.parse(fs.readFileSync(path.resolve(here, "../extension/manifest.json"), "utf8")).key;
  const id = extensionId(manifestKey);
  const written = JSON.parse(fs.readFileSync(r.files[0], "utf8"));
  assert.equal(written.name, HOST_NAME);
  assert.equal(path.basename(r.files[0]), `${HOST_NAME}.json`, "filename must equal the host name");
  assert.equal(written.type, "stdio");
  assert.deepEqual(written.allowed_origins, [`chrome-extension://${id}/`]);
  assert.equal(written.path, wrapperPath);
  assert.ok(path.isAbsolute(written.path));
  assert.ok(fs.statSync(wrapperPath).mode & 0o111, "the wrapper must be executable");
  assert.ok(!/\bexec node\b/.test(fs.readFileSync(wrapperPath, "utf8")),
    "a browser-launched host has no shell PATH, so node must be an absolute path");

  // Idempotent, and a second checkout must not evict the first.
  const before = fs.readFileSync(r.files[0], "utf8");
  installNativeHost(opts);
  assert.equal(fs.readFileSync(r.files[0], "utf8"), before, "re-running must be byte-identical");
  installNativeHost({ ...opts, ids: ["aaaabbbbccccddddeeeeffffgggghhhh"] });
  const unioned = JSON.parse(fs.readFileSync(r.files[0], "utf8"));
  assert.equal(unioned.allowed_origins.length, 2, "a second id is added, not swapped in");
  assert.ok(unioned.allowed_origins.includes(`chrome-extension://${id}/`));

  const gone = installNativeHost({ ...opts, uninstall: true });
  assert.equal(gone.removed.length, 3, "two manifests and the wrapper");
  assert.ok(!fs.existsSync(r.files[0]) && !fs.existsSync(wrapperPath));
  assert.match(installNativeHost({ ...opts, uninstall: true }).message, /nothing to remove/);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pp-nmh-empty-"));
  assert.throws(() => installNativeHost({ ...opts, root: empty }), /no Chromium-based browser/);
  assert.throws(() => installNativeHost({ ...opts, platform: "win32" }), /Windows/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

// The browser→host hop itself is not testable here (Playwright's Chromium reads the real
// user-level NativeMessagingHosts directory, and a test must not write there). Everything on
// either side of it is: this drives the host directly over its own stdio protocol.
const NMH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pp-host-"));
let WRAPPER = null;
function nativeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}
async function askHost(payload, env = null) {
  const p = spawn(WRAPPER, [], { env: env || ENV, stdio: ["pipe", "pipe", "pipe"] });
  p.stdin.end(Buffer.isBuffer(payload) ? payload : nativeFrame(payload));
  const out = [];
  p.stdout.on("data", (c) => out.push(c));
  p.stderr.on("data", () => {});
  const code = await new Promise((r) => p.once("close", r));
  const buf = Buffer.concat(out);
  if (buf.length < 4) return { code, reply: null };
  return { code, reply: JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString("utf8")) };
}

test("native host: answers ping, and finds node without a shell PATH", async () => {
  const { installNativeHost } = await import("../bridge/native-host.js");
  fs.mkdirSync(path.join(NMH_ROOT, "Google/Chrome"), { recursive: true });
  WRAPPER = path.join(NMH_ROOT, "pinpoint-host.sh");
  installNativeHost({ root: NMH_ROOT, platform: "darwin", wrapperPath: WRAPPER, home: HOME });

  const { reply } = await askHost({ cmd: "ping" });
  assert.equal(reply.ok, true);
  assert.ok(fs.existsSync(reply.cli), "ping must point at a cli.js that is really there");

  // Exactly the environment a browser gives it: launchd's PATH, no shell rc, no nvm shims.
  const bare = await askHost({ cmd: "ping" }, { PATH: "/usr/bin:/bin", HOME: process.env.HOME });
  assert.equal(bare.reply?.ok, true, "the wrapper must not depend on the user's PATH");
});

test("native host: one integer crosses the boundary, and nothing else", async () => {
  for (const port of ["7331; ls", 80, 7331.5, null, 99999]) {
    const { reply } = await askHost({ cmd: "start", port });
    assert.equal(reply.ok, false, `port ${JSON.stringify(port)} must be refused`);
    assert.equal(reply.code, "bad_port");
  }
  // No path, script or command name is honoured — there is exactly one thing this host can run.
  const evil = path.join(NMH_ROOT, "evil.js");
  fs.writeFileSync(evil, `require("fs").writeFileSync(${JSON.stringify(evil + ".ran")}, "x")`);
  for (const msg of [{ cmd: "exec", path: "/bin/sh" }, { cmd: "stop" }, {}]) {
    const { reply } = await askHost(msg);
    assert.equal(reply.ok, false);
    assert.equal(reply.code, "bad_request", `${JSON.stringify(msg)} must be refused`);
  }
  // A well-formed start carrying extra fields ignores them: only the port is ever read.
  assert.equal((await askHost({ cmd: "start", cli: evil, project: "/etc" })).reply.code, "bad_port");
  assert.ok(!fs.existsSync(evil + ".ran"), "a path in the message must never be run");

  const junk = await askHost(Buffer.from("not a frame at all"));
  assert.equal(junk.reply?.ok, false);
  const huge = Buffer.alloc(4);
  huge.writeUInt32LE(200000, 0);
  assert.equal((await askHost(Buffer.concat([huge, Buffer.alloc(10)]))).reply?.code, "bad_request");
});

test("native host: start detaches a real bridge, is idempotent, and reports a busy port", async () => {
  const PORT2 = 7395;
  const first = await askHost({ cmd: "start", port: PORT2 });
  assert.equal(first.reply.ok, true, JSON.stringify(first.reply));
  assert.ok(first.reply.pid > 0);
  // The host has already exited (we awaited its close) and the bridge is still answering: that is
  // the detach guarantee, and it is the thing most likely to regress silently.
  const h = await (await fetch(`http://127.0.0.1:${PORT2}/health`)).json();
  assert.equal(h.service, "pinpoint-bridge");
  assert.equal(h.dataFile, path.join(HOME, "annotations.json"), "PINPOINT_HOME must be baked into the wrapper");

  const again = await askHost({ cmd: "start", port: PORT2 });
  assert.equal(again.reply.already, true, "a mashed button must not spawn a second daemon");
  assert.equal(again.reply.pid, undefined);
  process.kill(first.reply.pid);
  await sleep(300);

  // Something else on the port: the bridge's own "already in use" paragraph is what the popup shows.
  const squatter = http.createServer((_q, s) => s.end("no"));
  await new Promise((r) => squatter.listen(PORT2, "127.0.0.1", r));
  const busy = await askHost({ cmd: "start", port: PORT2 });
  assert.equal(busy.reply.ok, false);
  assert.equal(busy.reply.code, "port_busy");
  assert.match(busy.reply.error, /in use/);
  await new Promise((r) => squatter.close(r));
  fs.rmSync(NMH_ROOT, { recursive: true, force: true });
});

test("two watching agents are handed different notes, not the same one twice", async () => {
  const w1 = fetch(BASE + "/annotations/wait?timeout=8000").then((r) => r.json());
  await sleep(150); // registration order is what decides who claims first
  const w2 = fetch(BASE + "/annotations/wait?timeout=8000").then((r) => r.json());
  await sleep(150);
  const a = sample({ comment: "first of two" });
  const b = sample({ comment: "second of two" });
  await postJson("/annotations", a);
  await sleep(250);
  await postJson("/annotations", b);
  const [r1, r2] = await Promise.all([w1, w2]);
  assert.ok(r1.annotation && r2.annotation, "both waiters must get something");
  assert.notEqual(r1.annotation.id, r2.annotation.id, "the same note must never go to two agents");
  assert.deepEqual([r1.annotation.id, r2.annotation.id].sort(), [a.id, b.id].sort());
});

test("a resolve is attributed, and the second agent is told it was already done", async () => {
  const a = sample({ comment: "who did this" });
  await postJson("/annotations", a);
  const first = await postJson(`/annotations/${a.id}/resolve`, { note: "made it purple in Hero.tsx:42", by: "claude-code" });
  assert.equal(first.ok, true);
  const got = (await (await fetch(`${BASE}/annotations/${a.id}`)).json()).annotation;
  assert.equal(got.resolvedBy, "claude-code");
  assert.equal(got.resolution, "made it purple in Hero.tsx:42");

  const second = await postJson(`/annotations/${a.id}/resolve`, { note: "also made it purple", by: "cursor-vscode" });
  assert.equal(second.ok, "already", "the second agent must be told, not silently ignored");
});

test("/events answers a client from a previous life at once instead of stalling for 25s", async () => {
  const { storeVersion } = await (await fetch(BASE + "/health")).json();
  const t0 = Date.now();
  const r = await (await fetch(`${BASE}/events?since=${storeVersion + 500}&timeout=25000`)).json();
  assert.ok(Date.now() - t0 < 2000, `answered in ${Date.now() - t0}ms — a restarted bridge must not freeze the pins`);
  assert.equal(r.version, storeVersion);
  assert.equal(r.changed, false);
});

test("POST /restart brings the bridge back with its annotations, flags and blocked callers", async () => {
  const PORT3 = 7394;
  const B3 = `http://127.0.0.1:${PORT3}`;
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "pp-restart-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pp-restart-home-"));
  const d = spawn("node", [CLI, "--port", String(PORT3), "--project", proj], {
    env: { ...process.env, PINPOINT_HOME: home }, stdio: ["ignore", "pipe", "pipe"],
  });
  d.stdout.on("data", () => {}); d.stderr.on("data", () => {});
  for (let i = 0; i < 60; i++) { try { await fetch(B3 + "/health"); break; } catch { await sleep(100); } }

  const a = sample({ comment: "survives a restart" });
  await fetch(B3 + "/annotations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a) });
  const before = await (await fetch(B3 + "/health")).json();

  // Both long-poll shapes are open across the restart: they must settle, not hang or throw.
  const events = fetch(`${B3}/events?since=${before.storeVersion}&timeout=25000`).then((r) => r.json()).catch((e) => ({ err: String(e) }));
  const waiting = fetch(`${B3}/annotations/wait?timeout=25000`).then((r) => r.json()).catch((e) => ({ err: String(e) }));
  await sleep(200);

  const t0 = Date.now();
  assert.equal((await (await fetch(B3 + "/restart", { method: "POST" })).json()).restarting, true);
  await Promise.race([Promise.all([events, waiting]), sleep(4000)]);
  assert.ok(Date.now() - t0 < 4000, "blocked callers must be released, not left to time out");

  let back = null;
  for (let i = 0; i < 60; i++) {
    try { back = await (await fetch(B3 + "/health")).json(); break; } catch { await sleep(100); }
  }
  assert.ok(back, "the bridge must come back on the same port");
  assert.notEqual(back.pid, before.pid, "it must really be a new process");
  assert.equal(back.project, proj, "--project must survive the re-exec");
  assert.equal(back.pending, before.pending, "annotations are on disk, so nothing is lost");

  try { process.kill(back.pid); } catch {}
  try { d.kill(); } catch {}
  await sleep(200);
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------- setup: the two-command install ----------

test("writeCursorMcp creates the file, keeps other servers and is idempotent", async () => {
  const { writeCursorMcp, mcpCommand } = await import("../bridge/agents.js");
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "pp-cursor-"));
  const file = path.join(proj, ".cursor/mcp.json");

  const r1 = writeCursorMcp(proj, CLI, {});
  assert.equal(r1.already, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.pinpoint, mcpCommand(CLI, {}));

  // someone else's server must survive ours being added twice
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.mcpServers.other = { command: "node", args: ["/x.js"] };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));

  const r2 = writeCursorMcp(proj, CLI, { port: 7444 });
  assert.equal(r2.already, true);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(after.mcpServers.other, { command: "node", args: ["/x.js"] });
  assert.deepEqual(after.mcpServers.pinpoint.args.slice(-2), ["--port", "7444"]);
  assert.equal(Object.keys(after.mcpServers).length, 2, "no duplicate pinpoint entry");

  fs.writeFileSync(file, "{ broken");
  assert.throws(() => writeCursorMcp(proj, CLI, {}), /not valid JSON/);
  fs.rmSync(proj, { recursive: true, force: true });
});

test("writeCodexMcp appends once, backs the file up and never doubles the block", async () => {
  const { writeCodexMcp } = await import("../bridge/agents.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-codex-"));
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(file, "[other]\nkey = 1\n");

  const r1 = writeCodexMcp(CLI, { file });
  assert.equal(r1.already, false);
  assert.equal(fs.readFileSync(r1.backup, "utf8"), "[other]\nkey = 1\n", "their file is kept as it was");
  const written = fs.readFileSync(file, "utf8");
  assert.match(written, /\[other\]/);
  assert.match(written, /\[mcp_servers\.pinpoint\]/);
  assert.match(written, new RegExp(`args = \\[${JSON.stringify(CLI).replace(/[\\/]/g, "\\$&")}, "mcp"\\]`));

  const r2 = writeCodexMcp(CLI, { file });
  assert.equal(r2.already, true);
  assert.equal(fs.readFileSync(file, "utf8").match(/\[mcp_servers\.pinpoint\]/g).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("detectBrowsers lists only the browsers that are actually installed", async () => {
  const { detectBrowsers } = await import("../bridge/native-host.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-browsers-"));
  assert.deepEqual(detectBrowsers({ platform: "darwin", root }), [], "nothing installed is an answer, not a crash");

  fs.mkdirSync(path.join(root, "BraveSoftware/Brave-Browser"), { recursive: true });
  const found = detectBrowsers({ platform: "darwin", root });
  assert.deepEqual(found.map((b) => b.name), ["Brave"]);
  assert.equal(found[0].url, "brave://extensions", "setup needs the page where Load unpacked lives");
  assert.equal(detectBrowsers({ platform: "sunos", root }).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("/health reports when the extension last talked to us, so setup can confirm it is loaded", async () => {
  const before = await (await fetch(BASE + "/health")).json();
  assert.equal(before.extensionSeenAt, null, "a CLI call is not the extension");

  await fetch(BASE + "/health", { headers: { origin: "chrome-extension://abcdefghijklmnop" } });
  const after = await (await fetch(BASE + "/health")).json();
  assert.ok(after.extensionSeenAt, "an extension-origin request marks it live");
  assert.ok(!Number.isNaN(Date.parse(after.extensionSeenAt)));
});

test("setup wires a project up in one non-interactive run, twice over", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pp-setup-home-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "pp-setup-proj-"));
  // HOME as well as PINPOINT_HOME: setup writes agent config and native-host manifests under it,
  // and a test that edited the developer's own ~/.claude.json would be a bug worth shipping never.
  const env = { ...process.env, HOME, USERPROFILE: home, PINPOINT_HOME: path.join(home, ".pinpoint") };
  const run = (args, cwd = undefined) => new Promise((res) => {
    const p = spawn("node", [CLI, "setup", "--yes", "--no-start", "--port", "7401", ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { p.kill(); res({ err, code: "HUNG" }); }, 60000);
    p.once("exit", (c) => { clearTimeout(t); res({ out, err, code: c }); });
  });

  const first = await run([proj]);
  assert.equal(first.code, 0, first.err);
  assert.match(first.err, /Load unpacked|no such|Pinpoint setup/);
  const settings = path.join(proj, ".claude/settings.json");
  assert.ok(fs.existsSync(settings), "hooks land without being asked");
  assert.match(fs.readFileSync(settings, "utf8"), /print --hook/);

  const second = await run([proj]);
  assert.equal(second.code, 0, second.err);
  const s = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(s.hooks.UserPromptSubmit.length, 1, "running setup twice does not duplicate anything");

  const bad = await run([path.join(proj, "nope")]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /no such directory/);
  assert.doesNotMatch(bad.err, /at .*\.js:\d+/, "a first-timer gets a sentence, not a stack trace");

  // Standing in the pinpoint clone itself, with no terminal to ask: fail fast with an instruction,
  // rather than wiring hooks into Pinpoint's own repo or waiting on a stdin that never comes.
  const nothing = await run([], path.resolve(here, ".."));
  assert.equal(nothing.code, 1);
  assert.match(nothing.err, /no project given/);

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

// ---------- staleness: telling the agent the page moved under a pin ----------

test("diffElement names what changed, and never calls an unfound element unchanged", async () => {
  const { diffElement, diffMarkdown } = await import("../bridge/store.js");
  const before = { selector: "h1", text: "Old", outerHTML: "<h1>Old</h1>", rect: { width: 100, height: 20 }, styles: { color: "red", "font-size": "54px" } };

  assert.equal(diffElement(before, { ...before }).verdict, "unchanged");
  assert.equal(diffElement(before, null).verdict, "gone", "no element is never 'unchanged'");

  const changed = diffElement(before, { ...before, text: "New", outerHTML: "<h1>New</h1>", styles: { color: "red", "font-size": "46px" } });
  assert.equal(changed.verdict, "changed");
  const md = diffMarkdown(changed);
  assert.match(md, /Text was "Old", is now "New"/);
  assert.match(md, /font-size: 54px → 46px/, "the changed property is named, not just 'styles changed'");

  // Found, but its own selector lands elsewhere: the element is fine and the selector is not.
  assert.equal(diffElement(before, { ...before }, { selectorStillMatches: false }).verdict, "moved");

  // A pixel of layout noise is not a change worth waking an agent for.
  assert.equal(diffElement(before, { ...before, rect: { width: 101, height: 20 } }).verdict, "unchanged");
});

test("a pin that reports itself gone reaches the agent — and does not bump the store version", async () => {
  await post(sample({ id: "stale001", comment: "make this wider" }));
  const versionBefore = (await (await fetch(BASE + "/health")).json()).storeVersion;

  const r = await fetch(BASE + `/annotations/stale001/element-state`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: "gone", at: new Date().toISOString(), url: "http://localhost:3000/" }),
  });
  assert.equal((await r.json()).ok, true);

  // The version must NOT move: it is what makes every tab reload its pins, which would re-run the
  // check that produced this report — a loop.
  const versionAfter = (await (await fetch(BASE + "/health")).json()).storeVersion;
  assert.equal(versionAfter, versionBefore, "reporting staleness must not trigger a reload in every tab");

  const md = await (await fetch(BASE + "/pending.md")).text();
  assert.match(md, /Possibly stale/, "the agent is told");
  assert.match(md, /recheck_annotation/, "and told what to do about it");
});

test("recheck_annotation asks the browser, and reports what came back", async () => {
  await fetch(BASE + "/annotations", { method: "DELETE" });
  await post(sample({ id: "rechk001", comment: "make this bold" }));
  await fetch(BASE + "/annotations/rechk001/screenshot", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ base64: "iVBORw0KGgo=", width: 10, height: 10 }),
  });

  const c = await httpClient();
  const call = c.callTool({ name: "recheck_annotation", arguments: { id: "rechk001", timeoutSeconds: 10 } });

  // Stand in for the extension: the question arrives on the events poll, the answer goes back as
  // a POST. Exactly the round trip the service worker makes.
  let req = null;
  for (let i = 0; i < 40 && !req; i++) {
    const ev = await (await fetch(BASE + "/events?since=0&timeout=500")).json();
    req = ev.rechecks?.[0] || null;
  }
  assert.ok(req, "the browser is asked");
  assert.equal(req.id, "rechk001");

  await fetch(BASE + `/rechecks/${req.reqId}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      status: "ok", selectorStillMatches: false,
      element: { selector: "button.primary", text: "Start free trial", outerHTML: "<button>Start free trial</button>", rect: { width: 120, height: 40 }, styles: { "font-weight": "700" } },
      screenshot: { base64: "iVBORw0KGgoAAAA=", width: 20, height: 20 },
    }),
  });

  const res = await call;
  const body = text(res);
  assert.match(body, /Verdict: moved/, body);
  assert.match(body, /Before —/);
  assert.match(body, /After —/);
  assert.equal(res.content.filter((b) => b.type === "image").length, 2, "the agent gets both crops");
  await c.close();
});

test("a re-check nobody answers says so, and never says the element is fine", async () => {
  await fetch(BASE + "/annotations", { method: "DELETE" });
  await post(sample({ id: "rechk002", comment: "tighten this" }));
  const c = await httpClient();
  const res = await c.callTool({ name: "recheck_annotation", arguments: { id: "rechk002", timeoutSeconds: 1 } });
  const body = text(res);
  assert.match(body, /Could not re-check/);
  assert.doesNotMatch(body, /unchanged|Verdict/, "silence is not a clean bill of health");
  assert.match(body, /still from when it was marked/, "and the stale details are labelled as such");
  await c.close();
});

test("resolving something the page has moved under warns, but never blocks", async () => {
  await fetch(BASE + "/annotations", { method: "DELETE" });
  await post(sample({ id: "stale002", comment: "make this full-width" }));
  await fetch(BASE + "/annotations/stale002/element-state", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: "gone" }),
  });

  const c = await httpClient();
  const res = await c.callTool({ name: "resolve_annotation", arguments: { id: "stale002", note: "made it full-width in Hero.tsx:12" } });
  const body = text(res);
  assert.match(body, /Resolved/, "the resolve still happens — this is a warning, not a gate");
  assert.match(body, /never re-checked/, body);
  const [a] = (await (await fetch(BASE + "/annotations?status=resolved")).json()).annotations;
  assert.equal(a.status, "resolved");
  await c.close();
});
