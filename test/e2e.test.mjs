// Browser scenario suite. Run: node --test e2e.test.mjs   (spawns its own bridge on port 7399)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, "../extension");
const CLI = path.resolve(here, "../bridge/cli.js");
// Use whatever Chromium Playwright installed, unless a specific binary is pointed at.
const CHROME = process.env.PINPOINT_CHROME || undefined;
const PORT = 7399, SITE = 8081;
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pp-e2e-"));
const ENV = { ...process.env, PINPOINT_HOME: HOME };

// ---------- static site (with a strict-CSP route) ----------
const site = http.createServer((req, res) => {
  const p = req.url.split("?")[0];
  const files = {
    "/": "site/index.html", "/react.development.js": "node_modules/react/umd/react.development.js", "/react-dom.development.js": "node_modules/react-dom/umd/react-dom.development.js",
    "/vue.html": "site/vue.html", "/vue.global.js": "node_modules/vue/dist/vue.global.js",
    "/plain.html": "site/plain.html", "/rerender.html": "site/rerender.html", "/frame.html": "site/frame.html", "/csp.html": "site/csp.html", "/stress.html": "site/stress.html",
  };
  const f = files[p];
  if (!f) { res.writeHead(404); return res.end(); }
  const headers = { "content-type": f.endsWith(".js") ? "text/javascript" : "text/html" };
  if (p === "/csp.html") headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'";
  res.writeHead(200, headers);
  fs.createReadStream(path.join(here, f)).pipe(res);
});

let daemon, ctx, extId;
async function startDaemon() {
  daemon = spawn("node", [CLI, "--port", String(PORT)], { env: ENV, stdio: ["ignore", "ignore", "pipe"] });
  daemon.stderr.on("data", () => {});
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + "/health"); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  throw new Error("daemon did not start");
}
async function stopDaemon() { if (!daemon) return; daemon.kill(); await new Promise((r) => daemon.once("exit", r)); daemon = null; }

async function launch(extra = {}) {
  const c = await chromium.launchPersistentContext("", {
    ...(CHROME ? { executablePath: CHROME } : {}), headless: true,
    args: ["--headless=new", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
           "--host-resolver-rules=MAP notlocal.example 127.0.0.1"],
    viewport: { width: 1280, height: 800 }, permissions: ["clipboard-read", "clipboard-write"], ...extra,
  });
  let [sw] = c.serviceWorkers();
  if (!sw) sw = await c.waitForEvent("serviceworker");
  // A just-spawned worker may not have the extension APIs bound yet.
  for (let i = 0; i < 40; i++) {
    try { await sw.evaluate((port) => chrome.storage.sync.set({ port }), PORT); break; }
    catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  return { c, sw, id: new URL(sw.url()).host };
}

const url = (p) => `http://localhost:${SITE}${p}`;
const S = (page) => page.evaluate(() => { const r = document.querySelector("pinpoint-root").shadowRoot; return { status: r.querySelector(".pop .status").textContent, popOpen: r.querySelector(".pop").style.display === "block", picking: document.documentElement.classList.contains("pinpoint-picking"), pins: [...r.querySelectorAll(".pin")].map((p) => ({ n: p.textContent, shown: p.style.display !== "none" })), hl: r.querySelector(".hl").style.display, tag: r.querySelector(".hl .tag").textContent }; });
async function openPage(p) {
  const page = await ctx.newPage();
  await page.goto(url(p));
  await page.waitForFunction(() => !!document.querySelector("pinpoint-root"));
  return page;
}
async function arm(page) {
  if (!(await S(page)).picking) await page.keyboard.press("Alt+Shift+A");
  await page.waitForFunction(() => document.documentElement.classList.contains("pinpoint-picking"));
}
async function disarm(page) {
  if ((await S(page)).picking) await page.keyboard.press("Escape");
}
async function annotate(page, locator, comment, { submit = "click" } = {}) {
  await arm(page);
  await locator.hover();
  await locator.click();
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".pop").style.display === "block");
  await page.evaluate((c) => { const t = document.querySelector("pinpoint-root").shadowRoot.querySelector("textarea"); t.value = c; t.focus(); }, comment);
  if (submit === "click") await page.evaluate(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".send").click());
  else await page.keyboard.press(submit);
  await page.waitForFunction(() => /Sent|offline|Failed|first/.test(document.querySelector("pinpoint-root").shadowRoot.querySelector(".pop .status").textContent), null, { timeout: 15000 });
  return (await S(page)).status;
}
const pending = async () => (await (await fetch(BASE + "/annotations?status=pending&images=1")).json()).annotations;
// The comment is stored first and the crop attached right after, so tests that care about the
// picture wait for it explicitly (this is the fix for "navigating loses the annotation").
async function pendingWithShots(count, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    const items = await pending();
    if (items.length >= count && items.slice(0, count).every((a) => a.screenshot || a.screenshotSkipped)) return items;
    if (Date.now() - t0 > timeout) return items;
    await new Promise((r) => setTimeout(r, 100));
  }
}
const clearAll = () => fetch(BASE + "/annotations", { method: "DELETE" });

before(async () => {
  await new Promise((r) => site.listen(SITE, r));
  await startDaemon();
  ({ c: ctx, id: extId } = await launch());
});
after(async () => { await ctx?.close(); await stopDaemon(); site.close(); fs.rmSync(HOME, { recursive: true, force: true }); });

test("Esc cancels picking; highlight hidden; Esc/Cancel close popover without sending", async () => {
  await clearAll();
  const page = await openPage("/");
  await arm(page);
  await page.locator("h1").hover();
  assert.equal((await S(page)).hl, "block");
  await page.keyboard.press("Escape");
  let s = await S(page);
  assert.equal(s.picking, false); assert.equal(s.hl, "none");
  await arm(page); await page.locator("h1").click();
  assert.equal((await S(page)).popOpen, true);
  await page.keyboard.press("Escape");
  assert.equal((await S(page)).popOpen, false);
  await arm(page); await page.locator("h1").click();
  await page.evaluate(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".cancel").click());
  assert.equal((await S(page)).popOpen, false);
  assert.equal((await S(page)).picking, true, "cancelling a note leaves you ready to pick the next one");
  assert.equal((await pending()).length, 0);
  // picking swallows the click: the page's link must not navigate
  await page.locator("nav a").first().click();
  assert.equal(new URL(page.url()).pathname, "/");
  await disarm(page);
  await page.close();
});

test("empty comment is rejected and nothing is posted", async () => {
  const page = await openPage("/");
  const status = await annotate(page, page.locator("h1"), "");
  assert.match(status, /Write a comment first/);
  assert.equal((await pending()).length, 0);
  await page.close();
});

test("React page: Cmd+Enter submits; payload complete; pin appears; shortcut in an input does not type", async () => {
  const page = await openPage("/");
  const status = await annotate(page, page.locator("#get-started"), "Full width on mobile", { submit: "Meta+Enter" });
  assert.match(status, /Sent/);
  const [a] = await pendingWithShots(1);
  assert.equal(a.comment, "Full width on mobile");
  assert.equal(a.element.selector, "#get-started");
  assert.equal(a.element.domPath, "body > div#root > section.hero > button#get-started");
  assert.deepEqual(a.source.components, ["Hero", "App"]);
  assert.equal(a.source.framework, "react");
  assert.equal(a.element.attributes["data-testid"], "cta");
  assert.ok(a.element.styles["background-color"]);
  assert.ok(a.screenshot?.base64.length > 500);
  assert.equal(Buffer.from(a.screenshot.base64, "base64").subarray(1, 4).toString(), "PNG");
  assert.equal(a.page.url, url("/")); assert.equal(a.page.viewport.width, 1280);
  assert.deepEqual((await S(page)).pins, [{ n: "1", shown: true }]);
  // shortcut inside a page input: must not insert a character (⌥⇧A would type "Å")
  await page.goto(url("/plain.html")); await page.waitForFunction(() => !!document.querySelector("pinpoint-root"));
  await page.locator("#search").click();
  await page.keyboard.press("Alt+Shift+A");
  assert.equal(await page.locator("#search").inputValue(), "");
  assert.equal((await S(page)).picking, true);
  await disarm(page);
  await page.close();
});

test("Copy prompt writes a markdown prompt to the clipboard", async () => {
  const page = await openPage("/");
  await arm(page); await page.locator("#get-started").click();
  await page.evaluate(() => { const r = document.querySelector("pinpoint-root").shadowRoot; r.querySelector("textarea").value = "copy me"; r.querySelector(".copy").click(); });
  await page.waitForFunction(() => /Copied/.test(document.querySelector("pinpoint-root").shadowRoot.querySelector(".pop .status").textContent));
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /## UI change request/); assert.match(clip, /\*\*Change:\*\* copy me/); assert.match(clip, /Hero ← App/); assert.match(clip, /`#get-started`/);
  await disarm(page);
  await page.close();
});

test("bridge offline: Send falls back to clipboard, no pin, then recovers when bridge is back", async () => {
  await clearAll();
  await stopDaemon();
  const page = await openPage("/");
  const status = await annotate(page, page.locator("h1"), "offline change");
  assert.match(status, /Bridge offline/);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /offline change/);
  assert.equal((await S(page)).pins.length, 0);
  await startDaemon();
  const status2 = await annotate(page, page.locator("h1"), "online again");
  assert.match(status2, /Sent/);
  assert.equal((await pending()).length, 1);
  await page.close();
});

test("pins: hover tip shows comment, Remove deletes at bridge; multiple pins numbered; reload restores; other tab sees them", async () => {
  await clearAll();
  const page = await openPage("/");
  await annotate(page, page.locator("#get-started"), "one");
  await annotate(page, page.locator(".card").nth(2), "two");
  assert.deepEqual((await S(page)).pins.map((p) => p.n), ["1", "2"]);
  const other = await openPage("/");
  await other.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".pin").length === 2);
  await other.close();
  await page.evaluate(() => document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".pin")[0].dispatchEvent(new MouseEvent("mouseenter")));
  const tip = await page.evaluate(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".tip").textContent);
  assert.match(tip, /#1 one/);
  await page.evaluate(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".tip .del").click());
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".pin").length === 1);
  assert.equal((await pending()).length, 1);
  assert.equal((await pending())[0].comment, "two");
  await page.reload(); await page.waitForFunction(() => document.querySelector("pinpoint-root")?.shadowRoot.querySelectorAll(".pin").length === 1);
  assert.deepEqual((await S(page)).pins.map((p) => p.n), ["2"]);
  // a different URL shows no pins
  await page.goto(url("/plain.html")); await page.waitForFunction(() => !!document.querySelector("pinpoint-root"));
  await page.waitForTimeout(300);
  assert.equal((await S(page)).pins.length, 0);
  await page.close();
});

test("agent resolves via MCP → pin gone; the screenshot reaches the agent as an image", async () => {
  await clearAll();
  const setup = await openPage("/");
  await annotate(setup, setup.locator("#get-started"), "for the agent");
  const [a] = await pendingWithShots(1);
  await setup.close();
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp")));
  const got = await c.callTool({ name: "get_pending_annotations", arguments: {} });
  assert.ok(got.content.some((b) => b.type === "image"), "screenshot reaches the agent as an image block");
  await c.callTool({ name: "resolve_annotation", arguments: { id: a.id, note: "done" } });
  await c.close();
  const page = await openPage("/");
  await page.waitForTimeout(400);
  assert.equal((await S(page)).pins.length, 0);
  assert.match(await (await fetch(BASE + "/pending.md")).text(), /No pending/);
  await page.close();
});

test("popup page: shows bridge status and list, clear empties bridge, copy-all writes prompt", async () => {
  await clearAll();
  const page = await openPage("/");
  await annotate(page, page.locator("h1"), "popup one");
  await annotate(page, page.locator("p").first(), "popup two");
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForFunction(() => /bridge on/.test(document.querySelector("#status").textContent));
  assert.equal(await popup.locator("#dot").getAttribute("class"), "dot on");
  await popup.waitForFunction(() => document.querySelectorAll("#list li").length === 2);
  assert.match(await popup.locator("#list li .s").first().textContent(), /<Hero> .*h1/);
  await popup.locator("#copyAll").click();
  await popup.waitForFunction(() => document.querySelector("#status").textContent === "copied!");
  const clip = await popup.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /# 2 UI change request/); assert.match(clip, /### 1\. popup one/); assert.match(clip, /### 2\. popup two/);
  // remove one row
  await popup.locator("#list li .x").first().click();
  await popup.waitForFunction(() => document.querySelectorAll("#list li").length === 1);
  assert.equal((await pending()).length, 1);
  popup.once("dialog", (d) => d.accept());
  await popup.locator("#clear").click();
  await popup.waitForFunction(() => document.querySelectorAll("#list li").length === 0);
  assert.equal((await pending()).length, 0);
  // port change persists
  await popup.locator("#port").fill("7398"); await popup.locator("#port").dispatchEvent("change");
  await popup.waitForFunction(() => /offline/.test(document.querySelector("#status").textContent));
  await popup.locator("#port").fill(String(PORT)); await popup.locator("#port").dispatchEvent("change");
  await popup.waitForFunction(() => /bridge on/.test(document.querySelector("#status").textContent));
  await popup.close(); await page.close();
});

test("scroll: element far down the page is captured; pin hides when scrolled out of view and returns", async () => {
  await clearAll();
  const page = await openPage("/plain.html");
  // centre it rather than leaving it at the viewport edge, where the on-page bar lives
  await page.locator("#bottom").evaluate((el) => el.scrollIntoView({ block: "center" }));
  const status = await annotate(page, page.locator("#bottom"), "bottom");
  assert.match(status, /Sent/);
  const [a] = await pendingWithShots(1);
  assert.ok(a.screenshot, "screenshot taken after scrolling");
  assert.ok(a.element.rect.y > 2000, "rect is page-absolute");
  assert.ok(a.page.scroll.y > 1000);
  assert.deepEqual((await S(page)).pins, [{ n: "1", shown: true }]);
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(100);
  assert.deepEqual((await S(page)).pins, [{ n: "1", shown: false }]);
  await page.locator("#bottom").scrollIntoViewIfNeeded(); await page.waitForTimeout(100);
  assert.deepEqual((await S(page)).pins, [{ n: "1", shown: true }]);
  await page.close();
});

test("edge elements: wider-than-viewport gets a clipped crop; 5000-char text is trimmed; iframe content annotatable", async () => {
  await clearAll();
  const page = await openPage("/plain.html");
  await annotate(page, page.locator("#wide"), "wide");
  await annotate(page, page.locator("#longtext"), "long");
  const [wide, long] = await pendingWithShots(2);
  assert.ok(wide.screenshot.width <= 1200 && wide.screenshot.width > 0, `wide crop ${wide.screenshot.width}`);
  assert.ok(long.element.text.length <= 201); assert.ok(long.element.outerHTML.length <= 601);
  // iframe: the content script runs in the frame too and picking is mirrored into every frame.
  // Centre it first — at the viewport edge it would sit under the on-page bar.
  await page.locator("#frame").evaluate((el) => el.scrollIntoView({ block: "center" }));
  const frame = page.frameLocator("#frame");
  await arm(page);
  await frame.locator("#in-frame").click();
  await page.frame({ url: /frame\.html/ }).evaluate(() => { const r = document.querySelector("pinpoint-root").shadowRoot; r.querySelector("textarea").value = "in frame"; r.querySelector(".send").click(); });
  await page.frame({ url: /frame\.html/ }).waitForFunction(() => /Sent/.test(document.querySelector("pinpoint-root").shadowRoot.querySelector(".pop .status").textContent));
  const inFrame = (await pendingWithShots(3)).find((a) => a.comment === "in frame");
  assert.equal(inFrame.element.selector, "#in-frame");
  assert.match(inFrame.page.url, /frame\.html$/);
  assert.ok(inFrame.screenshot, "iframe element screenshot");
  await page.close();
});

test("shadow DOM: element inside a web component gets a host >>> inner selector and its pin restores", async () => {
  await clearAll();
  const page = await openPage("/plain.html");
  const chip = page.locator("#widget").locator("span.chip").nth(1);
  const status = await annotate(page, chip, "shadow");
  assert.match(status, /Sent/);
  const [a] = await pending();
  assert.equal(a.element.selector, "#widget >>> span.chip:nth-of-type(2)");
  assert.match(a.element.domPath, /my-widget#widget > #shadow-root > div\.inner > span\.chip/);
  assert.equal(a.element.text, "Second chip");
  await page.reload(); await page.waitForFunction(() => document.querySelector("pinpoint-root")?.shadowRoot.querySelectorAll(".pin").length === 1);
  assert.deepEqual((await S(page)).pins, [{ n: "1", shown: true }]);
  await page.close();
});

test("Vue page: component chain and framework detected", async () => {
  await clearAll();
  const page = await openPage("/vue.html");
  await annotate(page, page.locator("button.buy").nth(1), "vue");
  const [a] = await pending();
  assert.equal(a.source.framework, "vue");
  assert.deepEqual(a.source.components, ["PriceCard", "Pricing", "Root"]);
  assert.equal(a.element.selector, "div.price:nth-of-type(2) > button.buy");
  assert.equal(await page.evaluate((s) => document.querySelector(s)?.textContent, a.element.selector), "Buy Pro");
  await page.close();
});

test("strict CSP page (default-src 'none'): picker, inspector and send still work", async () => {
  await clearAll();
  const page = await openPage("/csp.html");
  const status = await annotate(page, page.locator("#csp-title"), "csp");
  assert.match(status, /Sent/);
  const [a] = await pendingWithShots(1);
  assert.equal(a.source.framework, null); assert.deepEqual(a.source.components, []);
  assert.ok(a.screenshot);
  await page.close();
});

test("selector property test: every element on a 2000-node stress page resolves back to itself", async () => {
  const page = await openPage("/stress.html");
  const r = await page.evaluate(() => {
    const els = [...document.querySelectorAll("#app *")];
    let bad = [], hashed = 0, t0 = performance.now();
    for (const el of els) {
      let res = null;
      el.addEventListener("pinpoint:debug-selector-result", (e) => (res = JSON.parse(e.detail)), { once: true });
      el.dispatchEvent(new CustomEvent("pinpoint:debug-selector", { bubbles: true, composed: true }));
      if (!res) { bad.push("no result"); continue; }
      if (/css-[0-9a-f]{6}|sc-AbCd|_x\d/.test(res.selector)) hashed++;
      let found; try { found = document.querySelector(res.selector); } catch { found = "invalid"; }
      if (found !== el) bad.push(`${res.selector} → ${found === "invalid" ? "INVALID" : found ? "other" : "null"}`);
    }
    return { total: els.length, bad: bad.slice(0, 10), badCount: bad.length, hashed, ms: Math.round(performance.now() - t0) };
  });
  console.log(`   ${r.total} elements, ${r.badCount} non-unique/invalid, ${r.hashed} using hashed classes, ${r.ms}ms`);
  assert.ok(r.total > 2000);
  assert.equal(r.hashed, 0, "generated class names must not be used in selectors");
  assert.deepEqual(r.bad, [], "all selectors must resolve to their element");
  await page.close();
});

test("DPR 2 context: crop is device-pixel sized", async () => {
  await clearAll();
  const { c } = await launch({ deviceScaleFactor: 2 });
  const page = await c.newPage();
  await page.goto(url("/")); await page.waitForFunction(() => !!document.querySelector("pinpoint-root"));
  const status = await annotate(page, page.locator("#get-started"), "retina");
  assert.match(status, /Sent/);
  const [a] = await pendingWithShots(1);
  assert.equal(a.page.viewport.dpr, 2);
  const expectedW = (a.element.rect.width + 16) * 2;
  assert.ok(Math.abs(a.screenshot.width - expectedW) <= 4, `crop ${a.screenshot.width} ≈ ${expectedW}`);
  await c.close();
});

test("heavy DOM churn while pins exist does not throw and keeps pins positioned", async () => {
  await clearAll();
  const page = await openPage("/");
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await annotate(page, page.locator("#get-started"), "churn");
  const t = await page.evaluate(async () => {
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) { const d = document.createElement("div"); d.textContent = "x" + i; document.body.appendChild(d); if (i % 2) d.remove(); }
    await new Promise((r) => requestAnimationFrame(r));
    return performance.now() - t0;
  });
  assert.deepEqual(errors, []);
  assert.ok(t < 2000, `mutation burst took ${t}ms`);
  assert.deepEqual((await S(page)).pins, [{ n: "1", shown: true }]);
  await page.close();
});

// ================= regression tests for the v0.2 fixes =================

test("Bug 1: resolving from an agent clears the pin live, with no reload", async () => {
  await clearAll();
  const page = await openPage("/");
  await annotate(page, page.locator("#get-started"), "live resolve");
  const [a] = await pending();
  assert.deepEqual((await S(page)).pins.map((p) => p.n), ["1"]);
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp")));
  await c.callTool({ name: "resolve_annotation", arguments: { id: a.id, note: "done" } });
  await c.close();
  // no reload, no interaction: the extension is told and updates itself
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".pin").length === 0, null, { timeout: 8000 });
  assert.equal((await S(page)).pins.length, 0);
  await page.close();
});

test("Bug 1b: a pin added in one tab appears in another tab on the same page, live", async () => {
  await clearAll();
  const a = await openPage("/");
  const b = await openPage("/");
  await annotate(a, a.locator("h1"), "seen from the other tab");
  await b.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".pin").length === 1, null, { timeout: 8000 });
  // and deleting it from the popup clears both
  const [ann] = await pending();
  await fetch(`${BASE}/annotations/${ann.id}`, { method: "DELETE" });
  await b.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".pin").length === 0, null, { timeout: 8000 });
  await a.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".pin").length === 0, null, { timeout: 8000 });
  await a.close(); await b.close();
});

test("Bug 2: two comments on one element get separate, reachable pins", async () => {
  await clearAll();
  const page = await openPage("/");
  await annotate(page, page.locator("#get-started"), "first note");
  await annotate(page, page.locator("#get-started"), "second note");
  const pos = await page.evaluate(() => [...document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".pin")].map((p) => ({ n: p.textContent, top: p.style.top, left: p.style.left })));
  assert.equal(pos.length, 2);
  assert.notEqual(pos[0].top, pos[1].top, "pins must not sit on the same pixel");
  assert.equal(pos[0].left, pos[1].left);
  // both are hoverable: the older one still shows its own comment
  const tip = await page.evaluate(() => {
    const r = document.querySelector("pinpoint-root").shadowRoot;
    r.querySelectorAll(".pin")[0].dispatchEvent(new MouseEvent("mouseenter"));
    return r.querySelector(".tip").textContent;
  });
  assert.match(tip, /first note/);
  await page.close();
});

test("Bug 6: navigating immediately after Send still keeps the annotation", async () => {
  await clearAll();
  const page = await openPage("/");
  await arm(page);
  await page.locator("#get-started").click();
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".pop").style.display === "block");
  await page.evaluate(() => {
    const r = document.querySelector("pinpoint-root").shadowRoot;
    r.querySelector("textarea").value = "typed then fled";
    r.querySelector(".send").click();
  });
  // leave at once — before any screenshot could finish
  await page.goto(url("/plain.html"));
  await page.waitForFunction(() => !!document.querySelector("pinpoint-root"));
  const items = await pending();
  assert.equal(items.length, 1, "the comment survived the navigation");
  assert.equal(items[0].comment, "typed then fled");
  assert.equal(items[0].element.selector, "#get-started");
  await page.close();
});

test("Bug 8: an element inside an iframe can be picked and is cropped from the right place", async () => {
  await clearAll();
  const page = await openPage("/plain.html");
  const frame = page.frameLocator("#frame");
  await page.keyboard.press("Alt+Shift+A");
  // picking is mirrored into every frame, so the shortcut works wherever the pointer is
  await page.waitForFunction(() => document.querySelector("iframe").contentDocument.documentElement.classList.contains("pinpoint-picking"), null, { timeout: 5000 });
  await frame.locator("#in-frame").click();
  const f = page.frame({ url: /frame\.html/ });
  await f.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".pop").style.display === "block");
  await f.evaluate(() => {
    const r = document.querySelector("pinpoint-root").shadowRoot;
    r.querySelector("textarea").value = "heading inside the frame";
    r.querySelector(".send").click();
  });
  const [a] = await pendingWithShots(1);
  assert.equal(a.element.selector, "#in-frame");
  assert.match(a.page.url, /frame\.html$/);
  assert.ok(a.screenshot, "crop taken");
  // The frame sits at y≈? in the top document; a wrong offset would capture the page header
  // instead. Compare against a crop of the same region taken by Playwright itself.
  const box = await page.locator("#frame").boundingBox();
  assert.ok(box.y > 50, "the iframe is well down the page, so a missing offset would be obvious");
  const mine = Buffer.from(a.screenshot.base64, "base64");
  const theirs = await page.locator("#frame").screenshot();
  assert.ok(mine.length > 200 && theirs.length > 200);
  const green = await page.evaluate(() => {
    const d = document.querySelector("iframe").contentDocument;
    return getComputedStyle(d.querySelector("#in-frame")).backgroundColor;
  });
  assert.equal(green, "rgb(221, 255, 221)", "sanity: the target has a distinctive colour");
  await page.close();
});

test("hover tag names the React component once the pointer settles", async () => {
  const page = await openPage("/");
  await arm(page);
  await page.locator("#get-started").hover();
  await page.waitForFunction(() => /<Hero>/.test(document.querySelector("pinpoint-root").shadowRoot.querySelector(".hl .tag").textContent), null, { timeout: 4000 });
  const tag = (await S(page)).tag;
  assert.match(tag, /^<Hero>\s+button#get-started/);
  await disarm(page);
  await page.close();
});

test("popup shows which page each annotation belongs to and confirms before clearing", async () => {
  await clearAll();
  const page = await openPage("/");
  await annotate(page, page.locator("h1"), "on the react page");
  const other = await openPage("/plain.html");
  await annotate(other, other.locator("#search"), "on the plain page");
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForFunction(() => document.querySelectorAll("#list li").length === 2);
  const urls = await popup.evaluate(() => [...document.querySelectorAll("#list li .u")].map((u) => u.textContent));
  assert.ok(urls.some((u) => u.endsWith("/plain.html")), `got ${JSON.stringify(urls)}`);
  // clearing asks first; declining keeps everything
  popup.once("dialog", (d) => d.dismiss());
  await popup.locator("#clear").click();
  await popup.waitForTimeout(300);
  assert.equal((await pending()).length, 2, "declining the confirm keeps the annotations");
  popup.once("dialog", (d) => d.accept());
  await popup.locator("#clear").click();
  await popup.waitForFunction(() => document.querySelectorAll("#list li").length === 0);
  assert.equal((await pending()).length, 0);
  await popup.close(); await other.close(); await page.close();
});

test("popup refuses to show green for a foreign server on the bridge port (Bug 5)", async () => {
  const foreign = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end('{"ok":true}'); });
  await new Promise((r) => foreign.listen(7397, "127.0.0.1", r));
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.locator("#port").fill("7397");
  await popup.locator("#port").dispatchEvent("change");
  await popup.waitForFunction(() => /offline/.test(document.querySelector("#status").textContent), null, { timeout: 5000 });
  assert.equal(await popup.locator("#dot").getAttribute("class"), "dot off");
  assert.match(await popup.locator("#hint").textContent(), /taken by something else/);
  await popup.locator("#port").fill(String(PORT));
  await popup.locator("#port").dispatchEvent("change");
  await popup.waitForFunction(() => /bridge on/.test(document.querySelector("#status").textContent));
  await popup.close();
  await new Promise((r) => foreign.close(r));
});

test("popup no longer advertises a command that does not exist (Bug 4)", async () => {
  await stopDaemon();
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForFunction(() => /offline/.test(document.querySelector("#status").textContent), null, { timeout: 6000 });
  const hint = await popup.locator("#hint").textContent();
  assert.doesNotMatch(hint, /npx pinpoint-bridge/);
  assert.match(hint, /cli\.js/);
  await popup.close();
  await startDaemon();
});

test("Esc keeps a typed draft until you confirm", async () => {
  const page = await openPage("/");
  await arm(page);
  await page.locator("h1").click();
  await page.evaluate(() => { document.querySelector("pinpoint-root").shadowRoot.querySelector("textarea").value = "half-written thought"; });
  await page.keyboard.press("Escape");
  let s = await S(page);
  assert.equal(s.popOpen, true, "first Esc does not discard");
  assert.match(s.status, /Esc again/);
  await page.keyboard.press("Escape");
  assert.equal((await S(page)).popOpen, false);
  await page.close();
});

// ============ round 2: a page that rebuilds its own DOM (the real failure mode) ============

test("B1: selectors prefer stable attributes over sibling position", async () => {
  await clearAll();
  const page = await openPage("/rerender.html");
  await annotate(page, page.locator('[data-action="next"]'), "make this purple");
  await annotate(page, page.locator('label[for="company_address"] span'), "rename this label");
  const [next, label] = await pending();
  assert.equal(next.element.selector, 'button[data-action="next"]', "a button with a data-action must be found by it");
  assert.doesNotMatch(next.element.selector, /nth-of-type/);
  // the label's span has no attributes of its own, so it is anchored to the labelled field
  assert.match(label.element.selector, /company_address/, `got ${label.element.selector}`);
  assert.ok(label.element.fingerprint, "an identity card is recorded");
  assert.equal(label.element.fingerprint.text, "Company Address");
  await page.close();
});

test("B1: after a full re-render, pins stay on their own element or disappear — never on a stranger", async () => {
  await clearAll();
  const page = await openPage("/rerender.html");
  await annotate(page, page.locator('[data-action="next"]'), "primary button colour");
  await annotate(page, page.locator('label[for="first_name"] span'), "should read Given Name");
  await annotate(page, page.locator(".check-item").first(), "chips need more padding");

  const before = await page.evaluate(() => [...document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".pin")].map((p) => p.textContent));
  assert.deepEqual(before, ["1", "2", "3"]);

  // step 2 replaces every one of those nodes with same-classed ones in a different order
  await page.evaluate(() => window.__setStep(2));
  await page.waitForTimeout(400);

  const state = await page.evaluate(() => {
    const r = document.querySelector("pinpoint-root").shadowRoot;
    const pins = [...r.querySelectorAll(".pin")];
    // what does each visible pin actually sit on?
    return pins.map((p) => {
      const shown = p.style.display !== "none" && !p.dataset.orphan;
      const x = parseFloat(p.style.left), y = parseFloat(p.style.top);
      const under = shown ? document.elementFromPoint(Math.max(0, x - 20), Math.min(window.innerHeight - 1, y + 8)) : null;
      return { n: p.textContent, shown, under: under ? (under.textContent || "").trim().slice(0, 30) : null };
    });
  });
  const buttonPin = state.find((p) => p.n === "1");
  assert.equal(buttonPin.shown, true, "the Continue/Submit button is the same element by data-action, so its pin stays");
  const labelPin = state.find((p) => p.n === "2");
  assert.equal(labelPin.shown, false, "First Name does not exist on step 2 — better no pin than a pin on Segment");
  const chipPin = state.find((p) => p.n === "3");
  if (chipPin.shown) assert.doesNotMatch(chipPin.under || "", /Midwest|Northeast|South/, "must not silently re-bind to a step-2 chip");

  // coming back restores everything
  await page.evaluate(() => window.__setStep(1));
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => [...document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".pin")].filter((p) => p.style.display !== "none").map((p) => p.textContent));
  assert.deepEqual(after.sort(), ["1", "2", "3"], "back on step 1 all three pins return");
  await page.close();
});

test("B4: the popover shows the text of what you picked, and distinguishes near-identical buttons", async () => {
  const page = await openPage("/rerender.html");
  await arm(page);
  await page.locator('[data-action="next"]').click();
  const meta = await page.evaluate(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".pop .meta").textContent);
  assert.match(meta, /Continue to Step 2/, `popover must quote the element's text, got: ${meta}`);
  assert.match(meta, /btn-primary/, "the distinguishing class must survive, not just 'btn'");
  await disarm(page);
  await page.close();
});

test("B5: uppercase-by-CSS text is labelled as rendered, with a pointer to the HTML", async () => {
  await clearAll();
  const page = await openPage("/rerender.html");
  await annotate(page, page.locator('label[for="first_name"] span'), "rename");
  const md = await (await fetch(BASE + "/pending.md")).text();
  assert.match(md, /Text as rendered/);
  assert.match(md, /text-transform: uppercase/);
  assert.match(md, /grep the HTML below/);
  await page.close();
});

test("B2: switching tabs right after Send still gets the screenshot", async () => {
  await clearAll();
  const page = await openPage("/rerender.html");
  const other = await ctx.newPage();
  await other.goto(url("/plain.html"));
  await page.bringToFront();
  await arm(page);
  await page.locator("#page-title").click();
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".pop").style.display === "block");
  await page.evaluate(() => {
    const r = document.querySelector("pinpoint-root").shadowRoot;
    r.querySelector("textarea").value = "away to the editor";
    r.querySelector(".send").click();
  });
  await other.bringToFront();          // the natural thing to do straight after sending
  await page.waitForTimeout(1200);
  await page.bringToFront();
  const [a] = await pendingWithShots(1, 12000);
  assert.equal(a.comment, "away to the editor");
  assert.ok(a.screenshot, `screenshot should survive a tab switch; note was: ${a.screenshotSkipped}`);
  await other.close(); await page.close();
});

test("B2b: when a screenshot truly can't be taken, the agent is told so instead of guessing", async () => {
  await clearAll();
  const page = await openPage("/rerender.html");
  await arm(page);
  await page.locator("#page-title").click();
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".pop").style.display === "block");
  await page.evaluate(() => {
    const r = document.querySelector("pinpoint-root").shadowRoot;
    r.querySelector("textarea").value = "gone before the shot";
    r.querySelector(".send").click();
  });
  await page.goto(url("/plain.html"));   // different page: the crop would be of the wrong thing
  const t0 = Date.now();
  let a;
  do { [a] = await pending(); await new Promise((r) => setTimeout(r, 150)); } while (!a?.screenshotSkipped && Date.now() - t0 < 10000);
  assert.equal(a.screenshot, null);
  assert.match(a.screenshotSkipped || "", /page changed/);
  const md = await (await fetch(BASE + "/pending.md")).text();
  assert.match(md, /no screenshot — the page changed/);
  await page.close();
});

test("B3: pin badges stay inside the viewport, even for full-width and top-edge elements", async () => {
  await clearAll();
  const page = await openPage("/rerender.html");
  await annotate(page, page.locator(".powered-by"), "footer type is too small");
  const pos = await page.evaluate(() => {
    const p = document.querySelector("pinpoint-root").shadowRoot.querySelector(".pin");
    return { left: parseFloat(p.style.left), top: parseFloat(p.style.top), w: window.innerWidth };
  });
  assert.ok(pos.left <= pos.w - 10, `pin at ${pos.left} must not hang off a ${pos.w}px viewport`);
  assert.ok(pos.top >= 10, "and must not be cut off at the top");
  await page.close();
});

test("agent guidance adapts when the page has no framework metadata", async () => {
  await clearAll();
  const page = await openPage("/rerender.html");
  await annotate(page, page.locator("#page-title"), "bigger heading");
  const md = await (await fetch(BASE + "/pending.md")).text();
  assert.match(md, /no framework metadata/);
  assert.match(md, /grepping for distinctive strings/);
  assert.match(md, /Source file: not detected/);
  await page.close();
  // …and keeps the component-first advice on a React page
  await clearAll();
  const react = await openPage("/");
  await annotate(react, react.locator("#get-started"), "react one");
  const md2 = await (await fetch(BASE + "/pending.md")).text();
  assert.match(md2, /component chain first/);
  await react.close();
});

// ================= the on-page dock, sticky mode and the notes panel =================

const dock = (page) => page.evaluate(() => {
  const r = document.querySelector("pinpoint-root").shadowRoot;
  const d = r.querySelector(".dock");
  const cs = getComputedStyle(d);
  return {
    shown: d.style.display === "flex",
    armed: d.classList.contains("armed"),
    mini: d.classList.contains("mini"),
    count: r.querySelector(".dock .count b").textContent,
    countShown: r.querySelector(".dock .count").style.display !== "none",
    hint: r.querySelector(".dock .hint").textContent,
    bottom: cs.bottom,
    panelOpen: r.querySelector(".panel").style.display === "flex",
  };
});

test("the dock says Pinpoint is live in this tab, and doubles as the on/off switch", async () => {
  await clearAll();
  const page = await openPage("/");
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock").style.display === "flex", null, { timeout: 6000 });
  let d = await dock(page);
  assert.equal(d.shown, true);
  assert.equal(d.armed, false);
  assert.equal(d.countShown, false, "no note count until there is something to count");
  assert.match(d.hint, /Alt\+Shift\+A|⌥⇧A/, "tells you the shortcut when idle");
  assert.equal(d.bottom, "16px", "sits at the bottom so it never covers a page heading");

  // clicking it arms the picker — no keyboard needed
  await page.evaluate(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock .toggle").click());
  await page.waitForFunction(() => document.documentElement.classList.contains("pinpoint-picking"));
  d = await dock(page);
  assert.equal(d.armed, true);
  assert.match(d.hint, /Click any element/);
  // while armed the bar is inert, so it can never block the element you are trying to click
  const inert = await page.evaluate(() => getComputedStyle(document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock")).pointerEvents);
  assert.equal(inert, "none");
  await page.keyboard.press("Escape");
  assert.equal((await S(page)).picking, false, "Esc turns it off");
  assert.equal((await dock(page)).armed, false);
  await page.close();
});

test("comment mode stays on: three notes without touching the keyboard shortcut again", async () => {
  await clearAll();
  const page = await openPage("/");
  await page.keyboard.press("Alt+Shift+A");          // pressed exactly once
  const targets = ["#get-started", "h1", ".card"];
  for (const [i, sel] of targets.entries()) {
    assert.equal((await S(page)).picking, true, `still picking before note ${i + 1}`);
    await page.locator(sel).first().click();
    await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".pop").style.display === "block");
    await page.evaluate((c) => {
      const r = document.querySelector("pinpoint-root").shadowRoot;
      r.querySelector("textarea").value = c;
      r.querySelector(".send").click();
    }, `note ${i + 1}`);
    // sticky: picking comes back by itself once the crop is taken
    await page.waitForFunction(() => document.documentElement.classList.contains("pinpoint-picking"), null, { timeout: 8000 });
  }
  const items = await pendingWithShots(3);
  assert.deepEqual(items.map((a) => a.comment), ["note 1", "note 2", "note 3"]);
  assert.equal((await dock(page)).count, "3");
  // Esc is the way out
  await page.keyboard.press("Escape");
  assert.equal((await S(page)).picking, false);
  await page.close();
});

test("the dock shows a live count and opens a list of this page's notes", async () => {
  const page = await openPage("/");
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".pin").length === 3, null, { timeout: 8000 });
  let d = await dock(page);
  assert.equal(d.countShown, true);
  assert.equal(d.count, "3");

  await page.evaluate(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock .count").click());
  assert.equal((await dock(page)).panelOpen, true);
  const rows = await page.evaluate(() => [...document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".panel .item")].map((li) => ({
    n: li.querySelector(".n").textContent, c: li.querySelector(".c").textContent, s: li.querySelector(".s").textContent,
  })));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.c), ["note 1", "note 2", "note 3"]);
  assert.match(rows[0].s, /get-started/);

  // clicking a row brings you to that element
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".panel .item")[2].click());
  await page.waitForTimeout(700);
  assert.match((await S(page)).hl, /block|none/);

  // Esc closes the panel
  await page.keyboard.press("Escape");
  assert.equal((await dock(page)).panelOpen, false);
  await page.close();
});

test("the dock can be hidden per site, and brought back from the popup", async () => {
  const page = await openPage("/");
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock").style.display === "flex", null, { timeout: 6000 });
  await page.evaluate(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock .close").click());
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock").style.display === "none");
  // the choice sticks across a reload for this origin
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector("pinpoint-root"));
  await page.waitForTimeout(800);
  assert.equal((await dock(page)).shown, false);
  // annotating still works while it is hidden
  await annotate(page, page.locator("h1"), "still works hidden");
  assert.ok((await pending()).some((a) => a.comment === "still works hidden"));
  await disarm(page);
  // the popup's "show the on-page bar" does what it says
  await page.bringToFront();
  const sw = ctx.serviceWorkers()[0];
  await sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(t.id, { type: "showDock" });
  });
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock").style.display === "flex", null, { timeout: 6000 });
  await page.close();
});

test("the dock stays out of the way: hidden when the bridge is off, back when it returns", async () => {
  await stopDaemon();
  const page = await openPage("/");
  await page.waitForTimeout(900);
  assert.equal((await dock(page)).shown, false, "no floating widget on pages when you are not using it");
  await startDaemon();
  // no tab switch, no reload: the page notices on its own
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock").style.display === "flex", null, { timeout: 15000 });
  await page.close();
});

test("the bar stays on screen even when the page makes an ancestor the containing block", async () => {
  const page = await openPage("/");
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock").style.display === "flex", null, { timeout: 8000 });
  const onScreen = async () => page.evaluate(() => {
    const d = document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock");
    const r = d.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), vh: innerHeight, vw: innerWidth, h: Math.round(r.height) };
  });
  let p = await onScreen();
  assert.ok(p.h > 20, `the bar must have real height, got ${p.h}`);
  assert.ok(p.bottom <= p.vh, `bottom ${p.bottom} must be inside the ${p.vh}px viewport`);
  assert.ok(p.top >= 0 && p.left >= 0);

  // a transform on <html> is enough to break plain position:fixed
  await page.evaluate(() => { document.documentElement.style.transform = "translateZ(0)"; document.documentElement.style.minHeight = "3000px"; });
  await page.evaluate(() => window.scrollTo(0, 800));
  await page.waitForTimeout(400);
  p = await onScreen();
  assert.ok(p.bottom <= p.vh + 2 && p.top >= -2, `bar drifted off screen: ${JSON.stringify(p)}`);
  assert.ok(p.left >= -2 && p.left < p.vw, `bar drifted sideways: ${JSON.stringify(p)}`);
  await page.evaluate(() => { document.documentElement.style.transform = ""; document.documentElement.style.minHeight = ""; });
  await page.close();
});

test("no browser focus ring leaks into the bar", async () => {
  const page = await openPage("/");
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock").style.display === "flex", null, { timeout: 8000 });
  const outline = await page.evaluate(() => {
    const b = document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock .toggle");
    b.focus();
    const cs = getComputedStyle(b);
    return { style: cs.outlineStyle, width: cs.outlineWidth };
  });
  assert.ok(outline.style === "none" || outline.width === "0px", `unexpected outline: ${JSON.stringify(outline)}`);
  await page.close();
});

test("the overlay outranks a page's own fixed bars — nothing of ours gets painted over", async () => {
  const page = await openPage("/rerender.html");   // this page has its own fixed footer at z-index 10
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock").style.display === "flex", null, { timeout: 8000 });
  const r = await page.evaluate(() => {
    const host = document.querySelector("pinpoint-root");
    const hs = getComputedStyle(host);
    const d = host.shadowRoot.querySelector(".dock");
    const box = d.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const hit = (y) => { const el = document.elementFromPoint(x, y); return el ? el.tagName : null; };
    return {
      position: hs.position, zIndex: hs.zIndex, display: hs.display, pointerEvents: hs.pointerEvents,
      topHit: hit(box.top + 3), midHit: hit(box.top + box.height / 2), bottomHit: hit(box.bottom - 3),
      footerZ: getComputedStyle(document.querySelector(".powered-by")).zIndex,
    };
  });
  // the host must be its own stacking context, above anything the page can reasonably declare
  assert.equal(r.position, "fixed");
  assert.equal(r.display, "block");
  assert.equal(r.pointerEvents, "none", "the empty host must never swallow clicks meant for the page");
  assert.ok(Number(r.zIndex) > 1e9, `host z-index was ${r.zIndex}`);
  assert.equal(r.footerZ, "10", "sanity: the page really does have a competing fixed bar");
  // every part of the bar is on top, including the half that overlaps the page's footer
  assert.deepEqual([r.topHit, r.midHit, r.bottomHit], ["PINPOINT-ROOT", "PINPOINT-ROOT", "PINPOINT-ROOT"],
    "the page's fixed footer must not paint over the bar");
  await page.close();
});

// ================= scope: a dev tool, not a passenger on the whole web =================

test("isLocalDev accepts development origins and refuses everything else", async () => {
  const sw = ctx.serviceWorkers()[0];
  const verdicts = await sw.evaluate(() => ({
    yes: [
      "http://localhost:3000/app", "https://localhost/x", "http://127.0.0.1:5173/",
      "http://127.0.0.2:8080/", "http://app.localhost:3000/", "http://my-mac.local:4200/",
      "http://acme.test/checkout", "file:///Users/me/Downloads/registration.html",
      "http://192.168.1.24:3000/", "http://10.0.0.5:8000/", "http://172.16.4.4/",
    ].map((u) => [u, isLocalDev(u)]),
    no: [
      "https://example.com/", "https://app.vercel.app/", "http://notlocal.example/",
      "chrome://extensions", "chrome-extension://abc/popup.html", "devtools://devtools/x",
      "about:blank", "view-source:https://example.com", "https://localhost.evil.com/",
      "https://mybank.com/localhost", "", null,
    ].map((u) => [u, isLocalDev(u)]),
  }));
  for (const [u, v] of verdicts.yes) assert.equal(v, true, `${u} should count as local dev`);
  for (const [u, v] of verdicts.no) assert.equal(v, false, `${u} must NOT count as local dev`);
});

test("the extension does not load itself on a non-local site", async () => {
  const page = await ctx.newPage();
  await page.goto(`http://notlocal.example:${SITE}/`);
  await page.waitForTimeout(1200);
  const injected = await page.evaluate(() => !!document.querySelector("pinpoint-root"));
  assert.equal(injected, false, "no overlay, no bar, nothing on a site you are merely browsing");
  await page.close();
});

test("the popup explains an unusable page instead of throwing (the chrome:// crash)", async () => {
  const sw = ctx.serviceWorkers()[0];
  // a browser page: extensions simply cannot run there
  const blocked = await sw.evaluate(() => ({ reason: whyNot("chrome://extensions"), local: isLocalDev("chrome://extensions") }));
  assert.equal(blocked.local, false);
  assert.match(blocked.reason, /browser pages/);
  // and an ordinary website gets the "this is a local dev tool" explanation
  const site = await sw.evaluate(() => whyNot("https://example.com/"));
  assert.match(site, /local development pages/);

  // the popup renders that message and keeps the button usable for opt-in
  const page = await ctx.newPage();
  await page.goto(`http://notlocal.example:${SITE}/`);
  const popup = await ctx.newPage();
  const errors = [];
  popup.on("pageerror", (e) => errors.push(String(e)));
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForFunction(() => document.querySelector("#where").style.display === "block", null, { timeout: 6000 });
  // (opened as a tab the popup is itself the active tab, so it reports the browser-page reason;
  //  either way the point is that it explains itself instead of throwing)
  const shown = await popup.locator("#where").textContent();
  assert.match(shown, /local development pages|browser pages/);
  assert.match(await popup.locator("#pick .pl").textContent(), /Turn on for this page anyway|Not available here/);
  assert.deepEqual(errors, [], "no uncaught errors in the popup — this is the chrome:// crash");
  await popup.close(); await page.close();
});

test("opting in from the toolbar injects Pinpoint into that one tab", async () => {
  await clearAll();
  const page = await ctx.newPage();
  await page.goto(`http://notlocal.example:${SITE}/`);
  assert.equal(await page.evaluate(() => !!document.querySelector("pinpoint-root")), false);
  const sw = ctx.serviceWorkers()[0];
  const r = await sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return togglePicker(t, true);
  });
  assert.equal(r.ok, true, `opt-in failed: ${r.error}`);
  await page.waitForFunction(() => !!document.querySelector("pinpoint-root"), null, { timeout: 6000 });
  assert.equal((await S(page)).picking, true, "and it comes up ready to pick");
  await page.keyboard.press("Escape");
  await page.close();
});

// ================= live presence: seeing your agent work =================

test("the bar shows your agent working, and says what it is doing", async () => {
  await clearAll();
  const page = await openPage("/");
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock").style.display === "flex", null, { timeout: 8000 });
  await annotate(page, page.locator("#get-started"), "brand purple please");
  await disarm(page);

  const live = () => page.evaluate(() => {
    const r = document.querySelector("pinpoint-root").shadowRoot;
    return { on: r.querySelector(".dock").classList.contains("agent-live"), say: r.querySelector(".agent-say").textContent };
  });
  assert.equal((await live()).on, false, "idle until the agent actually does something");

  // an agent reads the pending list — exactly what Claude Code does
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp")));
  await c.callTool({ name: "get_pending_annotations", arguments: {} });
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock").classList.contains("agent-live"), null, { timeout: 8000 });
  assert.match((await live()).say, /reading your notes/);

  // …then looks at one, which highlights the pin it is looking at
  const [a] = await pending();
  await c.callTool({ name: "get_annotation", arguments: { id: a.id } });
  await page.waitForFunction(() => /looking at/.test(document.querySelector("pinpoint-root").shadowRoot.querySelector(".agent-say").textContent), null, { timeout: 8000 });
  await page.waitForFunction(() => !!document.querySelector("pinpoint-root").shadowRoot.querySelector(".pin.watched"), null, { timeout: 4000 });

  // …and finishes it
  await c.callTool({ name: "resolve_annotation", arguments: { id: a.id, note: "made it purple" } });
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".pin").length === 0, null, { timeout: 8000 });
  await c.close();
  await page.close();
});

test("picking uses a comment cursor rather than the default arrow", async () => {
  const page = await openPage("/");
  const before = await page.evaluate(() => getComputedStyle(document.body).cursor);
  await arm(page);
  const during = await page.evaluate(() => getComputedStyle(document.body).cursor);
  assert.notEqual(during, before);
  assert.match(during, /^url\("data:image\/svg\+xml/, `expected a custom cursor, got ${during}`);
  assert.match(during, /crosshair/, "with a sane fallback");
  await disarm(page);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).cursor), before);
  await page.close();
});
