// Pinpoint background service worker.
// Responsibilities: crop screenshots (kept in memory, never written to disk), talk to the local
// bridge, keep the toolbar badge in sync, and long-poll the bridge for changes so pins added or
// resolved anywhere show up in every open tab without a reload.

const DEFAULT_PORT = 7331;
const WATCH_ALARM = "pinpoint-watch";

// Pinpoint is a tool for the app you are building, not a thing that follows you around the web.
// It runs on local development pages only; anywhere else you have to turn it on deliberately,
// per tab, from the toolbar.
function isLocalDev(url) {
  if (!url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === "file:") return true;
  if (!/^https?:$/.test(u.protocol)) return false;      // chrome://, devtools://, about:, extensions
  const h = u.hostname;
  return h === "localhost" || h.endsWith(".localhost") ||
    h === "0.0.0.0" || h === "[::1]" || h === "::1" ||
    /^127\./.test(h) ||                                  // the whole loopback range
    /^10\./.test(h) ||                                   // private LAN, for testing on a phone
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h.endsWith(".local") || h.endsWith(".test") || h.endsWith(".localhost");
}

async function whyNot(url) {
  if (!url) return "Open a page first.";
  if (/^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):/.test(url)) {
    return "Chrome doesn't let extensions run on browser pages like this one.";
  }
  // Chrome keeps file:// access off per-extension, and off is the default. Without it we are never
  // injected into a file:// page at all — so name the switch instead of claiming the page is fine.
  if (url.startsWith("file:") && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    return 'Turn on "Allow access to file URLs" for Pinpoint on chrome://extensions, then reload this page.';
  }
  return "Pinpoint runs on local development pages — localhost, 127.0.0.1, a .local/.test host, or a file:// page.";
}

async function getPort() {
  const { port } = await chrome.storage.sync.get({ port: DEFAULT_PORT });
  return port;
}

async function bridgeFetch(path, init) {
  const res = await fetch(`http://127.0.0.1:${await getPort()}${path}`, init);
  if (!res.ok) throw new Error(`Bridge ${res.status} ${res.statusText}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

// Any server can sit on 7331; only ours answers with this marker. Without the check the popup
// would show a green dot for an unrelated dev server and every send would fail.
async function health() {
  const h = await bridgeFetch("/health");
  if (!h || h.service !== "pinpoint-bridge") throw new Error("Another server is on this port");
  return h;
}

async function updateBadge(count) {
  try {
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#e5484d" });
  } catch {}
}

async function refreshBadge() {
  try {
    const { annotations } = await bridgeFetch("/annotations?status=pending");
    await updateBadge(annotations.length);
    return annotations;
  } catch {
    await updateBadge(0);
    return null;
  }
}

// Tell every tab (and every frame in it) to re-read its pins from the bridge.
async function broadcastReload() {
  const tabs = (await chrome.tabs.query({})).filter((t) => isLocalDev(t.url));
  await Promise.all(tabs.map((t) => t.id && chrome.tabs.sendMessage(t.id, { type: "reloadPins" }).catch(() => {})));
}

// ---------- change watcher ----------
// A pending fetch keeps the service worker alive; the alarm restarts the loop if Chrome
// still evicts us (or if the bridge was down and has come back).
let watching = false;
async function watch() {
  if (watching) return;
  watching = true;
  try {
    let since = (await chrome.storage.session.get({ storeVersion: 0 })).storeVersion;
    let first = true;
    for (;;) {
      let res;
      try {
        res = await bridgeFetch(`/events?since=${since}&timeout=25000`);
      } catch {
        await updateBadge(0);
        return; // bridge down: the alarm will try again shortly
      }
      if (first) { first = false; broadcastReload(); }   // tell open tabs the bridge is up
      if (res.version !== since) {
        since = res.version;
        await chrome.storage.session.set({ storeVersion: since });
        await refreshBadge();
        await broadcastReload();
      }
    }
  } finally {
    watching = false;
  }
}

chrome.alarms.create(WATCH_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === WATCH_ALARM && watch());
chrome.runtime.onStartup.addListener(() => { refreshBadge(); watch(); });
chrome.runtime.onInstalled.addListener(() => { refreshBadge(); watch(); });
watch();

// Crop the visible tab to `rect` (CSS px, top-document viewport coordinates) at ratio `dpr`.
async function captureElement(windowId, rect, dpr, pad = 8) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  const sx = Math.max(0, Math.floor((rect.x - pad) * dpr));
  const sy = Math.max(0, Math.floor((rect.y - pad) * dpr));
  const sw = Math.min(bitmap.width - sx, Math.ceil((rect.width + pad * 2) * dpr));
  const sh = Math.min(bitmap.height - sy, Math.ceil((rect.height + pad * 2) * dpr));
  if (sw <= 0 || sh <= 0) { bitmap.close(); return null; }

  const scale = Math.min(1, 1200 / Math.max(sw, sh));
  const canvas = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { base64: btoa(binary), width: canvas.width, height: canvas.height };
}

// Chrome rate-limits captureVisibleTab (a couple of calls a second) and simply throws past that,
// so captures are serialised with a small gap and retried once. Annotating three things quickly
// must not cost you three screenshots.
let captureChain = Promise.resolve();
let lastCaptureAt = 0;
const MIN_GAP_MS = 650;

function queueCapture(fn) {
  const run = captureChain.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastCaptureAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { lastCaptureAt = Date.now(); }
  });
  captureChain = run.catch(() => {});
  return run;
}

// A queued capture must never photograph a different page: if the tab has navigated, been closed,
// or is no longer the visible one, we skip the picture rather than attach a misleading one.
async function tabState(tab, expectedUrl) {
  try {
    const t = await chrome.tabs.get(tab.id);
    if (!t) return "gone";
    if ((t.url || "").split("#")[0] !== (expectedUrl || "").split("#")[0]) return "navigated";
    return t.active ? "ready" : "hidden";
  } catch {
    return "gone";
  }
}

// captureVisibleTab photographs whichever tab is visible, so we can only shoot while ours is.
// Switching to your editor the moment you hit Send is the most natural thing in the world, so
// wait a few seconds for the tab to come back rather than silently dropping the picture.
async function waitUntilCapturable(tab, expectedUrl, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const state = await tabState(tab, expectedUrl);
    if (state !== "hidden") return state;
    if (Date.now() > deadline) return "hidden";
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function finishCapture(tab, capture, id, expectedUrl) {
  try {
    let why = null;
    const shot = await queueCapture(async () => {
      const state = await waitUntilCapturable(tab, expectedUrl);
      if (state !== "ready") {
        why = { navigated: "the page changed before it could be taken", gone: "the tab was closed", hidden: "the tab stayed in the background" }[state];
        return null;
      }
      // Give the compositor a frame to paint without our overlay before grabbing the pixels.
      await new Promise((r) => setTimeout(r, 60));
      try {
        return await captureElement(tab.windowId, capture.rect, capture.dpr);
      } catch {
        await new Promise((r) => setTimeout(r, 700));
        return captureElement(tab.windowId, capture.rect, capture.dpr);
      }
    });
    // Either way the bridge is told, so nothing silently pretends a picture exists.
    await bridgeFetch(`/annotations/${encodeURIComponent(id)}/screenshot`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify(shot || { skipped: why || "the screenshot could not be taken" }),
    });
  } catch (e) {
    console.warn("[pinpoint] screenshot not attached:", e);
  } finally {
    // Let the page show its overlay again (harmless if the tab has already gone).
    chrome.tabs.sendMessage(tab.id, { type: "captureDone" }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "capture": {
        const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
        return captureElement(windowId, msg.rect, msg.dpr);
      }
      // Two-phase send: the comment is stored first so nothing is lost if the page navigates
      // while the screenshot is being taken.
      case "submit": {
        const result = await bridgeFetch("/annotations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(msg.annotation),
        });
        refreshBadge();
        // The crop is taken and attached HERE, in the worker, after we have already answered.
        // The page can navigate or reload the instant it sees "Sent ✓" and both the comment and
        // its screenshot still arrive.
        if (msg.capture && sender.tab) {
          // Compare against the TAB's url, not the annotation's — an element inside an iframe
          // has the frame's url but is captured from the top-level tab.
          setTimeout(() => finishCapture(sender.tab, msg.capture, result.id, sender.tab.url), 0);
        }
        return result;
      }
      case "attachScreenshot": {
        return bridgeFetch(`/annotations/${encodeURIComponent(msg.id)}/screenshot`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(msg.screenshot),
        });
      }
      case "list": {
        const q = msg.url ? `?status=pending&url=${encodeURIComponent(msg.url)}` : "?status=pending";
        return bridgeFetch(`/annotations${q}`);
      }
      case "delete": {
        const r = await bridgeFetch(`/annotations/${encodeURIComponent(msg.id)}`, { method: "DELETE" });
        refreshBadge();
        return r;
      }
      case "clear": {
        const r = await bridgeFetch("/annotations", { method: "DELETE" });
        refreshBadge();
        return r;
      }
      case "health": {
        try {
          const h = await health();
          watch();
          return { ok: true, ...h };
        } catch (e) {
          return { ok: false, error: String(e.message || e) };
        }
      }
      case "refreshBadge":
        return refreshBadge();
      // A content script that handled the shortcut itself asks us to mirror it into sibling frames.
      case "mirrorPicking": {
        if (sender.tab?.id) {
          chrome.tabs.sendMessage(sender.tab.id, { type: "setPicking", picking: msg.picking, from: sender.frameId ?? 0 }).catch(() => {});
        }
        return { ok: true };
      }
      case "pick": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return { ok: false, error: "No active tab." };
        return togglePicker(tab, true);
      }
      case "canRun": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return { url: tab?.url || null, local: isLocalDev(tab?.url), reason: await whyNot(tab?.url) };
      }
      default:
        return { error: `unknown message ${msg.type}` };
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e.message || e) }));
  return true; // async response
});

// The keyboard command and the popup button both go to every frame, so elements inside
// iframes can be picked too.
async function togglePicker(tab, force) {
  const msg = { type: force ? "startPicker" : "togglePicker" };
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
    return { ok: true };
  } catch {}
  // Not injected yet — either the page pre-dates the extension, or the user is opting in on a
  // page outside the local-dev list (the toolbar click grants us this one tab).
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["inspector.js"], world: "MAIN" });
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
    await chrome.scripting.insertCSS({ target: { tabId: tab.id, allFrames: true }, files: ["content.css"] });
    await chrome.tabs.sendMessage(tab.id, msg);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: await whyNot(tab.url) };
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-picker") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) togglePicker(tab, false).catch(() => {});
});
