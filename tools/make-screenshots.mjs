// Regenerates the README's screenshots against demo/index.html, so every picture in the README is
// the real extension on the real demo site rather than a hand-cropped one-off.
//
//   node tools/make-screenshots.mjs          (from the repo root; needs test/node_modules)
//
// Everything is temporary: its own bridge on its own port, its own PINPOINT_HOME, its own browser
// profile. It never touches ~/.pinpoint or a bridge you have running.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "../test/node_modules/playwright/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "images");
const PORT = 7392, SITE = 8092;
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pp-shots-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const demo = fs.readFileSync(path.join(ROOT, "demo", "index.html"));
const site = http.createServer((_q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end(demo); });

const bridge = spawn("node", [path.join(ROOT, "bridge", "cli.js"), "--port", String(PORT), "--quiet"],
  { env: { ...process.env, PINPOINT_HOME: HOME }, stdio: ["ignore", "ignore", "pipe"] });
bridge.stderr.on("data", () => {});

// Shots are clipped rather than element-cropped: a locator screenshot cuts the drop shadow off at
// the border, which makes a floating bar look pasted on.
async function shot(page, name, box, pad = 18) {
  const clip = {
    x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
    width: box.width + pad * 2, height: box.height + pad * 2,
  };
  await page.screenshot({ path: path.join(OUT, name), clip });
  const kb = Math.round(fs.statSync(path.join(OUT, name)).size / 1024);
  console.log(`  ${name}  ${Math.round(clip.width)}×${Math.round(clip.height)}  ${kb} KB`);
}
const dockBox = (page) => page.evaluate(() =>
  document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock").getBoundingClientRect().toJSON());

async function main() {
  await new Promise((r) => site.listen(SITE, r));
  for (let i = 0; i < 60; i++) { try { await fetch(BASE + "/health"); break; } catch { await sleep(100); } }
  fs.mkdirSync(OUT, { recursive: true });

  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: ["--headless=new", `--disable-extensions-except=${path.join(ROOT, "extension")}`,
           `--load-extension=${path.join(ROOT, "extension")}`],
    viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2,
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  for (let i = 0; i < 40; i++) {
    // Bottom-right throughout: the demo's header is sticky and its "Book a demo" button sits
    // exactly under a top-right bar, so the default corner photographs as two overlapping things.
    // Any corner is a supported setting.
    try { await sw.evaluate((p) => chrome.storage.sync.set({ port: p, dockPos: "br" }), PORT); break; }
    catch { await sleep(150); }
  }

  const open = async () => {
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${SITE}/`);
    await page.waitForFunction(() => !!document.querySelector("pinpoint-root"));
    await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock").style.display === "flex", null, { timeout: 10000 });
    return page;
  };
  const arm = async (page) => {
    await page.keyboard.press("Alt+Shift+A");
    await page.waitForFunction(() => document.documentElement.classList.contains("pinpoint-picking"));
  };
  // Comment mode deliberately stays on after a send, and Escape closes the popover before it stops
  // picking — so press the bar's own Stop instead, which does exactly one thing.
  const disarm = async (page) => {
    for (let i = 0; i < 4; i++) {
      if (!(await page.evaluate(() => document.documentElement.classList.contains("pinpoint-picking")))) return;
      await page.evaluate(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock .stop").click());
      await sleep(200);
    }
    throw new Error("could not stop picking");
  };
  const type = (page, text) => page.evaluate((c) => {
    const t = document.querySelector("pinpoint-root").shadowRoot.querySelector("textarea");
    t.value = c; t.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  const send = async (page) => {
    await page.evaluate(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".send").click());
    await page.waitForFunction(() => /Sent/.test(document.querySelector("pinpoint-root").shadowRoot.querySelector(".pop .status").textContent), null, { timeout: 15000 });
    // Sending deliberately keeps picking on, but only once the worker has finished the screenshot
    // and sent "captureDone" — so anything that stops picking before that gets silently re-armed.
    for (let i = 0; i < 100; i++) {
      const items = (await (await fetch(BASE + "/annotations?status=pending")).json()).annotations;
      if (items.length && items.every((a) => a.hasScreenshot || a.screenshotSkipped)) break;
      await sleep(100);
    }
    await sleep(300);
  };
  const clearAll = () => fetch(BASE + "/annotations", { method: "DELETE" });

  // ---- the bar, in its three states -------------------------------------------------
  console.log("bar");
  let page = await open();
  await page.locator("pinpoint-root .dock").hover();
  await sleep(300);
  await shot(page, "bar-idle.png", await dockBox(page));

  await page.mouse.move(640, 600);
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock").classList.contains("mini"), null, { timeout: 8000 });
  await sleep(300);
  await shot(page, "bar-mini.png", await dockBox(page));

  await arm(page);
  await sleep(300);
  await shot(page, "bar-armed.png", await dockBox(page));
  await page.close();

  // ---- the comment popover, on a real element -----------------------------------------
  console.log("popover");
  await clearAll();
  page = await open();
  await arm(page);
  const target = page.locator(".hero .cta .btn.primary");
  await target.hover();
  await target.click();
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".pop").style.display === "block");
  await type(page, "Make this the only button — the second one competes with it.");
  await sleep(250);
  const popBox = await page.evaluate(() => {
    const r = document.querySelector("pinpoint-root").shadowRoot;
    const a = r.querySelector(".pop").getBoundingClientRect(), b = r.querySelector(".hl").getBoundingClientRect();
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.right, b.right) - x, height: Math.max(a.bottom, b.bottom) - y };
  });
  await shot(page, "popover.png", popBox, 22);
  await send(page);

  // ---- the numbered pin ---------------------------------------------------------------
  console.log("pin");
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".pin").length === 1, null, { timeout: 8000 });
  await disarm(page);
  await sleep(400);
  await shot(page, "pin.png", await target.boundingBox(), 34);

  // ---- the hero: the bar in the corner, a pin on the page -----------------------------
  console.log("hero");
  // A shorter frame: at full height the stats and the next section leave a band of empty page
  // between them, and the bar is pinned to the bottom so the clip cannot simply be trimmed.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await page.waitForFunction(() => document.querySelector("pinpoint-root")?.shadowRoot.querySelector(".dock").style.display === "flex", null, { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".pin").length === 1, null, { timeout: 10000 });
  await page.locator("pinpoint-root .dock").hover();
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, "hero.png") });
  console.log(`  hero.png  1280×720  ${Math.round(fs.statSync(path.join(OUT, "hero.png")).size / 1024)} KB`);
  await page.close();

  // ---- a region drawn across a group --------------------------------------------------
  console.log("region");
  await clearAll();
  page = await open();
  await arm(page);
  const tiers = await page.locator(".tiers").boundingBox();
  await page.locator(".tiers").scrollIntoViewIfNeeded();
  await sleep(400);
  const g = await page.locator(".tiers").boundingBox();
  const from = { x: g.x + 6, y: g.y + 6 };
  const to = { x: g.x + g.width - 6, y: g.y + Math.min(300, g.height - 6) };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 40, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await sleep(250);
  await shot(page, "region.png", { x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y }, 26);
  await page.mouse.up();
  await disarm(page);
  await page.close();

  // ---- a finished note, with the agent's own reply ------------------------------------
  console.log("agent reply");
  await clearAll();
  page = await open();
  await arm(page);
  const head = page.locator("#features h2");
  await head.scrollIntoViewIfNeeded();
  await head.hover();
  await head.click();
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".pop").style.display === "block");
  await type(page, "This heading is too long — cut it to five words.");
  await send(page);
  await disarm(page);

  const second = page.locator("#pricing .tier.featured .price");
  await second.scrollIntoViewIfNeeded();
  await arm(page);
  await second.hover();
  await second.click();
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".pop").style.display === "block");
  await type(page, "Show the annual price too, struck through.");
  await send(page);
  await disarm(page);

  // Resolve the first one the way an agent does: with a note saying what it changed. That reply is
  // what the panel shows, and it is the whole point of the picture.
  const items = (await (await fetch(BASE + "/annotations?status=pending")).json()).annotations;
  const first = items.find((a) => /heading/.test(a.comment));
  await fetch(`${BASE}/annotations/${first.id}/resolve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      note: 'Shortened it to "Built for whoever chases the truck" in demo/index.html:181.',
      by: "claude-code",
    }),
  });
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelectorAll(".pin").length === 1, null, { timeout: 10000 });

  await page.locator("pinpoint-root .dock").hover();
  await page.evaluate(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".dock .count").click());
  await page.waitForFunction(() => document.querySelector("pinpoint-root").shadowRoot.querySelector(".panel .reply"), null, { timeout: 10000 });
  await sleep(400);
  // The panel is a full-height sidebar; cropping to it leaves ~1000px of empty white below the
  // last note. Crop to where the content actually ends.
  const panel = await page.evaluate(() => {
    const p = document.querySelector("pinpoint-root").shadowRoot.querySelector(".panel");
    const r = p.getBoundingClientRect();
    const rows = [...p.querySelectorAll("li")];
    const bottom = rows.length ? rows[rows.length - 1].getBoundingClientRect().bottom : r.bottom;
    return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, bottom - r.y + 14) };
  });
  await shot(page, "agent-reply.png", panel, 20);
  await page.close();

  await ctx.close();
}

try {
  await main();
} finally {
  bridge.kill();
  site.close();
  fs.rmSync(HOME, { recursive: true, force: true });
}
