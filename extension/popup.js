// Safari and Firefox expose the promise-based extension API as `browser`; Chrome only has
// `chrome`. Prefer `browser` where it exists so every `await chrome.…` below works on all three.
const chrome = globalThis.browser ?? globalThis.chrome;

const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg);
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.host + (x.pathname === "/" ? "" : x.pathname);
  } catch { return u; }
}

async function refresh() {
  const where = await send({ type: "canRun" });
  const pick = $("#pick");
  if (where && !where.local) {
    // Not a local dev page. Say so plainly rather than failing when the button is pressed.
    $("#where").textContent = where.reason;
    $("#where").style.display = "block";
    const browserPage = /browser pages/.test(where.reason || "");
    pick.disabled = browserPage;
    pick.querySelector(".pl").textContent = browserPage ? "Not available here" : "Turn on for this page anyway";
  } else {
    $("#where").style.display = "none";
    pick.disabled = false;
    pick.querySelector(".pl").textContent = "Annotate an element";
  }

  const h = await send({ type: "health" });
  $("#dot").className = "dot " + (h.ok ? "on" : "off");
  $("#status").textContent = h.ok ? `bridge on :${h.port}${h.project ? " · " + h.project.split("/").pop() : ""}` : "bridge offline";
  // The bridge tells us where it lives, so once it has run once we can name the real command
  // instead of a <pinpoint> placeholder nobody can copy.
  if (h.cliPath) { cliPath = h.cliPath; chrome.storage.local.set({ cliPath }).catch(() => {}); }
  paintBridgeButton(h);
  $("#hint").innerHTML = h.ok
    ? ""
    : /Another server/.test(h.error || "")
      ? `Port ${$("#port").value} is taken by something else — change the port below, or start the bridge with --port.`
      : `Or start it in a terminal: <code>node ${esc(cliPath || "<pinpoint>/bridge/cli.js")} --project &lt;your repo&gt;</code>`;

  const res = h.ok ? await send({ type: "list" }) : null;
  const list = $("#list");
  list.innerHTML = "";
  const items = res?.annotations || [];
  $("#copyAll").disabled = $("#clear").disabled = !items.length;
  if (!items.length) {
    list.innerHTML = `<div class="empty">${h.ok ? "No pending annotations" : ""}</div>`;
    return;
  }
  const here = (where?.url || "").split("#")[0];
  for (const a of items) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="n">${a.number}</span><div class="c"><div class="t"></div><div class="s"></div><div class="u"></div></div><span class="x" title="Remove">✕</span>`;
    li.querySelector(".t").textContent = a.comment;
    li.querySelector(".s").textContent = (a.source?.components?.[0] ? `<${a.source.components[0]}> ` : "") + a.element.selector;
    const u = li.querySelector(".u");
    u.textContent = shortUrl(a.page.url);
    if (a.page.url.split("#")[0] === here) u.classList.add("current");
    li.querySelector(".x").onclick = async () => {
      await send({ type: "delete", id: a.id });
      refresh();
    };
    list.appendChild(li);
  }
}

// ---------- starting / restarting the bridge ----------
let cliPath = null;
chrome.storage.local.get({ cliPath: null }).then((v) => { cliPath = v.cliPath; }).catch(() => {});
const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
// Safari has no native messaging host of this kind, so it gets Restart (plain HTTP) but not Start.
const canStart = typeof chrome.runtime.sendNativeMessage === "function";

function paintBridgeButton(h) {
  const btn = $("#bridge");
  btn.style.display = h.ok || canStart ? "flex" : "none";
  btn.disabled = false;
  btn.querySelector(".bg").textContent = h.ok ? "↻" : "▶";
  btn.querySelector(".bl").textContent = h.ok ? "Restart bridge" : "Start bridge";
}

$("#bridge").onclick = async () => {
  const btn = $("#bridge");
  const running = btn.querySelector(".bg").textContent === "↻";
  btn.disabled = true;
  btn.querySelector(".bl").textContent = running ? "Restarting…" : "Starting…";
  const r = await send({ type: running ? "restartBridge" : "startBridge" });
  if (r?.ok) { $("#hint").textContent = ""; refresh(); return; }
  // Everything that can go wrong here ends in "run the installer once", except a busy port,
  // which the bridge's own message already explains better than we could.
  const install = `node ${esc(cliPath || "<pinpoint>/bridge/cli.js")} install-native-host`;
  $("#hint").innerHTML =
    r?.code === "no_host" ? `One-time setup. Run this once, then press again — if you have already run it, run it again, the extension's id may have changed:<br><code>${install}</code>`
    : r?.code === "no_node" ? `The launcher couldn't find Node. Run this again, then press again:<br><code>${install}</code>`
    : r?.code === "unsupported" ? esc(r.error)
    : `<span style="white-space:pre-wrap">${esc(r?.error || "the bridge did not start")}</span>`;
  refresh();
};

$("#pick").onclick = async () => {
  // The background never throws for an unusable page — it answers with a reason.
  let r;
  try { r = await send({ type: "pick" }); } catch (e) { r = { ok: false, error: String(e.message || e) }; }
  if (r && r.ok === false) {
    $("#where").textContent = r.error;
    $("#where").style.display = "block";
    return;
  }
  window.close();
};

$("#copyAll").onclick = async () => {
  const res = await send({ type: "list" });
  const items = res?.annotations || [];
  if (!items.length) return;
  const text = items.map((a, i) => formatPrompt(a, i + 1)).join("\n\n---\n\n");
  await navigator.clipboard.writeText(`# ${items.length} UI change request(s)\n\n` + text);
  $("#status").textContent = "copied!";
  setTimeout(refresh, 900);
};

$("#clear").onclick = async () => {
  const res = await send({ type: "list" });
  const n = res?.annotations?.length || 0;
  if (n && !confirm(`Delete ${n} annotation${n === 1 ? "" : "s"}? This can't be undone.`)) return;
  await send({ type: "clear" });
  refresh();
};

$("#showbar").onclick = async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: "showDock" }); } catch {}
  window.close();
};

// Nothing in this popup may throw into the console when the tab is a page we cannot touch.
window.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  $("#where").textContent = String(e.reason?.message || e.reason);
  $("#where").style.display = "block";
});

$("#help").onclick = (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("help.html") });
};

chrome.storage.sync.get({ port: 7331, dockPos: "tr" }).then(({ port, dockPos }) => {
  $("#port").value = port;
  $("#dockPos").value = dockPos;
});
$("#dockPos").onchange = async (e) => {
  await chrome.storage.sync.set({ dockPos: e.target.value });
  const tab = await activeTab();
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "showDock" }).catch(() => {});
};
$("#port").onchange = async (e) => {
  await chrome.storage.sync.set({ port: Number(e.target.value) || 7331 });
  refresh();
};

// Show the shortcut the user's platform actually uses.
$("#kpick").textContent = MAC ? "⌥⇧A" : "Alt+Shift+A";

function formatPrompt(a, n) {
  const s = a.source || {};
  const lines = [`### ${n}. ${a.comment}`, ``, `- Page: ${a.page.url}`, `- Element: \`${a.element.selector}\``, `- DOM path: ${a.element.domPath}`];
  if (a.element.text) lines.push(`- Text: "${a.element.text}"`);
  if (s.components?.length) lines.push(`- Component chain (${s.framework}): ${s.components.join(" ← ")}`);
  if (s.file) lines.push(`- Source: ${s.file}${s.line ? ":" + s.line : ""}`);
  lines.push(`- Size: ${a.element.rect.width}×${a.element.rect.height}px at viewport ${a.page.viewport.width}×${a.page.viewport.height}`);
  const st = Object.entries(a.element.styles || {}).map(([k, v]) => `${k}: ${v}`).join("; ");
  if (st) lines.push(`- Computed styles: ${st}`);
  lines.push("", "```html", a.element.outerHTML, "```");
  return lines.join("\n");
}

refresh();
