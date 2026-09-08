// Pinpoint content script — element picker, comment popover, numbered pins.
// Everything UI lives inside a shadow root so page CSS can't touch it and vice versa.
(() => {
  if (window.__pinpointLoaded) return;
  window.__pinpointLoaded = true;

  // ---------- state ----------
  let picking = false;
  let hovered = null;
  let selected = null;
  let pins = []; // { id, number, selector, comment, el }

  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const K_SEND = MAC ? "\u2318\u21a9" : "Ctrl+Enter";

  // ---------- shadow UI ----------
  const host = document.createElement("pinpoint-root");
  host.setAttribute("data-pinpoint", "");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        --accent: #6d5ae6;
        --agent: #b8582e;
        --accent-ink: #ffffff;
        --surface: rgba(255,255,255,.97);
        --surface-2: #f4f4f6;
        --ink: #17171c;
        --ink-dim: #6b6b76;
        --line: rgba(0,0,0,.09);
        --shadow: 0 1px 2px rgba(16,16,24,.06), 0 10px 30px rgba(16,16,24,.16);
        --radius: 12px;
        --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
        --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        all: initial;
      }
      @media (prefers-color-scheme: dark) {
        :host {
          --surface: rgba(28,28,32,.97);
          --surface-2: #2a2a30;
          --ink: #f2f2f5;
          --ink-dim: #a1a1ab;
          --agent: #e08a5b;
          --line: rgba(255,255,255,.12);
          --shadow: 0 1px 2px rgba(0,0,0,.4), 0 10px 30px rgba(0,0,0,.45);
        }
      }
      * { box-sizing: border-box; font-family: var(--sans); }
      button { border: 0; background: none; padding: 0; margin: 0; cursor: pointer; color: inherit; font: inherit; outline: none; -webkit-tap-highlight-color: transparent; }
      button:focus { outline: none; }
      button:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent); }

      /* ---------- element highlight ---------- */
      .hl {
        position: fixed; pointer-events: none; display: none; border-radius: 4px;
        outline: 2px solid var(--accent); outline-offset: 1px;
        background: color-mix(in srgb, var(--accent) 9%, transparent);
        transition: all 60ms cubic-bezier(.2,.8,.2,1);
      }
      .hl .tag {
        position: absolute; left: -3px; top: -23px; display: inline-flex; gap: 6px; align-items: center;
        background: var(--accent); color: var(--accent-ink); font: 500 11px/1 var(--mono);
        padding: 5px 7px; border-radius: 5px 5px 5px 0; white-space: nowrap;
        max-width: 70vw; overflow: hidden; text-overflow: ellipsis;
        box-shadow: 0 2px 8px rgba(0,0,0,.2);
      }
      .hl .tag b { font-weight: 700; }
      /* The element you picked reads as "held", not "wrong" — neutral ink, distinct from the
         accent used while merely hovering. */
      .hl.selected { outline-color: var(--ink); background: color-mix(in srgb, var(--ink) 7%, transparent); }
      .hl.selected .tag { background: var(--ink); color: var(--surface-2); }
      .hl.flash { animation: flash 1s ease-out; }
      @keyframes flash { 0%,100% { background: transparent } 30% { background: color-mix(in srgb, var(--accent) 22%, transparent) } }

      /* ---------- the dock: "Pinpoint is on in this tab" ---------- */
      .dock {
        position: fixed; bottom: 16px; left: 16px;
        display: none; align-items: center; gap: 2px; pointer-events: auto;
        background: var(--surface); color: var(--ink);
        border: 1px solid var(--line); border-radius: 999px;
        box-shadow: var(--shadow); padding: 3px;
        backdrop-filter: saturate(180%) blur(12px);
        /* Deliberately NOT dimmed. Fading the whole bar (was .58 at rest, .4 minified) took the
           label to 4.4:1, the shortcut keycap to 2.34:1 and the minified bar to 2.55:1 against a
           white page — under the 4.5:1 AA floor. Discretion comes from size and position now. */
        /* No transition on transform. keepDockOnScreen() sets transform:none and measures on the
           very next line; with a transition that rect is read mid-animation, so the correction is
           computed from the wrong position. The transform is only ever a position fix, never an
           effect, so there is nothing here worth animating. */
        font-size: 12px; user-select: none;
      }
      .dock.pos-br { left: auto; right: 16px; }
      .dock.pos-tl { bottom: auto; top: 16px; }
      .dock.pos-tr { bottom: auto; top: 16px; left: auto; right: 16px; }
      .dock.mini .label, .dock.mini .hint, .dock.mini .sep, .dock.mini .close { display: none; }
      .dock.mini { padding: 3px; }
      .dock.mini .toggle { padding: 0 6px; }
      /* While picking, every click belongs to the page: the bar goes inert so it can never sit
         between you and the element you want, wherever it is. Esc (or the shortcut) stops. */
      .dock.armed { pointer-events: none; }
      /* ...except the one control whose whole job is to stop. Clicking the armed bar used to fall
         through and annotate whatever sat beneath it, while the "Esc" hint lived inside the thing
         you could no longer click. The bar stays inert; Stop takes its pointer events back. */
      .dock .stop { display: none; }
      .dock.armed .stop {
        display: inline-flex; align-items: center; pointer-events: auto;
        border-radius: 999px; height: 24px; padding: 0 10px; line-height: 1; font-weight: 600;
        /* Ink on surface, NOT accent-ink: only the toggle pill turns violet when armed — the bar
           itself stays var(--surface). White-on-white measured 1.00:1, i.e. invisible. This pair
           inverts with the theme (17.9:1 light, 15.2:1 dark) and stays distinct from the violet
           state pill next to it. */
        background: var(--ink); color: var(--surface);
      }
      .dock.armed .stop:hover { background: color-mix(in srgb, var(--ink) 82%, var(--surface)); }
      .dock.armed .label { display: none; }
      .dock.armed .sep, .dock.armed .close { display: none; }
      .dock.mini .count { padding: 0 8px; }
      .dock.armed { opacity: 1; border-color: var(--accent); }
      /* Every direct child sits on the same 24px optical row, with one horizontal rhythm.
         Before, the toggle padded 5/10, close 5/8, count 5/10 and .who 0/4/0/6 — four different
         rhythms in a 200px bar. */
      .dock button { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px;
                     height: 24px; padding: 0 10px; line-height: 1; }
      .dock button:hover { background: var(--surface-2); }
      .dock .toggle { font-weight: 600; }
      .dock.armed .toggle { background: var(--accent); color: var(--accent-ink); }
      .dock.armed .toggle:hover { background: var(--accent); }
      .mark { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); flex: none; }
      .dock.armed .mark { background: var(--accent-ink); box-shadow: 0 0 0 3px rgba(255,255,255,.35); animation: pulse 1.6s ease-in-out infinite; }
      @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .45 } }
      .dock .hint { color: var(--ink-dim); font-size: 11px; }
      .dock.armed .hint { color: var(--accent-ink); opacity: .85; }
      .dock kbd { font: 11px/1 var(--mono); letter-spacing: .06em; border: 1px solid currentColor;
                  opacity: .5; border-radius: 4px; padding: 3px 5px 3px 6px;
                  display: inline-flex; align-items: center; }
      /* who is here — you, and your coding agent when it is doing something */
      /* Two hues, both of which mean something: violet is you (the same violet as your pins and
         the brand mark), orange is the agent. The old palette also carried #a8577f for "you" — a
         mauve unrelated to either, so the bar showed three hues from three corners of the wheel
         (h248, h330, h18) and read as muddy rather than designed. */
      .who { display: inline-flex; align-items: center; gap: 0; }
      .av { width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
            box-shadow: 0 0 0 2px var(--surface); color: var(--accent-ink); flex: none; }
      .av.you { background: var(--accent); position: relative; z-index: 1; }
      /* Idle, the agent is absent — drawn as an outline, not a colour. Greyscaling the orange fill
         produced ~#cacaca, which left its white glyph at 1.64:1: a blob you cannot read. */
      .av.agent { background: var(--surface); color: var(--ink-dim); margin-left: -6px;
                  box-shadow: 0 0 0 2px var(--surface), inset 0 0 0 1px var(--line);
                  transition: background 200ms ease, color 200ms ease, box-shadow 200ms ease; }
      .dock.agent-live .av.agent { background: var(--agent); color: var(--accent-ink);
                  box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px color-mix(in srgb, var(--agent) 40%, transparent); }
      .dock.agent-live .av.agent svg { animation: spin 2.6s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg) } }
      .agent-say { color: var(--ink-dim); font-size: 11px; max-width: 0; overflow: hidden; white-space: nowrap; opacity: 0;
                   transition: max-width 220ms ease, opacity 180ms ease; }
      .dock.agent-live .agent-say { max-width: 190px; opacity: 1; padding-right: 4px; }
      .dock.mini .who, .dock.mini .agent-say { display: none; }
      .dock.mini.agent-live .who { display: inline-flex; }
      .dock .count { color: var(--ink-dim); font-variant-numeric: tabular-nums; }
      .dock .count b { color: var(--ink); font-weight: 600; }
      .dock .sep { width: 1px; height: 14px; background: var(--line); margin: 0 4px; flex: none; align-self: center; }
      .dock .close { color: var(--ink-dim); height: 24px; width: 24px; padding: 0; font-size: 14px;
                     justify-content: center; }

      /* ---------- region marquee: drag to take a whole area, not one element ---------- */
      .marquee {
        position: fixed; display: none; pointer-events: none; z-index: 3;
        border: 1px dashed var(--accent); border-radius: 3px;
        background: color-mix(in srgb, var(--accent) 7%, transparent);
      }
      .marquee::after {
        content: ""; position: absolute; left: -4px; top: -4px; width: 8px; height: 8px;
        border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--surface);
      }
      .marquee .size {
        position: absolute; right: 0; bottom: -21px; font: 500 10px/1 var(--mono);
        background: var(--accent); color: var(--accent-ink); padding: 4px 5px; border-radius: 4px;
        white-space: nowrap;
      }

      /* ---------- comment popover ---------- */
      .pop {
        position: fixed; z-index: 3; width: 340px; pointer-events: auto; display: none;
        background: var(--surface); color: var(--ink);
        border: 1px solid var(--line); border-radius: var(--radius);
        box-shadow: var(--shadow); padding: 12px;
        backdrop-filter: saturate(180%) blur(12px);
        animation: pop 120ms cubic-bezier(.2,.8,.2,1);
      }
      @keyframes pop { from { opacity: 0; transform: translateY(-4px) scale(.985) } }
      .pop .meta { font: 11px/1.45 var(--mono); color: var(--ink-dim); margin-bottom: 8px; }
      .pop .meta .row { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pop .meta b { color: var(--accent); font-weight: 600; }
      .pop .meta .picked { color: var(--ink); font-family: var(--sans); font-size: 12.5px; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pop textarea {
        width: 100%; min-height: 76px; resize: vertical; color: var(--ink);
        background: var(--surface-2); border: 1px solid transparent; border-radius: 9px;
        padding: 9px 10px; font: 13px/1.5 var(--sans); outline: none;
        transition: border-color 120ms ease, box-shadow 120ms ease;
      }
      .pop textarea::placeholder { color: var(--ink-dim); }
      .pop textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
      .pop .row2 { display: flex; gap: 6px; margin-top: 9px; align-items: center; }
      .pop .row2 button { border-radius: 8px; padding: 7px 12px; font-size: 12px; font-weight: 600; }
      .pop .send { background: var(--accent); color: var(--accent-ink); display: inline-flex; gap: 7px; align-items: center; }
      .pop .send:hover { filter: brightness(1.08); }
      .pop .send kbd { font: 10px/1 var(--mono); opacity: .7; border: 1px solid currentColor; border-radius: 4px; padding: 2px 4px; }
      .pop .ghost { background: var(--surface-2); color: var(--ink); }
      .pop .ghost:hover { filter: brightness(.95); }
      .pop .status { margin-left: auto; font-size: 11px; color: var(--ink-dim); }
      .pop .status.err { color: #e5484d; }
      .pop .status.ok { color: #2a9d5c; }

      /* ---------- pins ---------- */
      .pin {
        position: fixed; z-index: 2; min-width: 20px; height: 20px; padding: 0 6px;
        /* Your marks are the accent, not error red: a pending note is not a fault, and white on
           #e5484d measured 3.91:1 at 11px bold. Red now means only "error" or "delete". */
        border-radius: 999px; background: var(--accent); color: var(--accent-ink);
        font: 700 11px/20px var(--sans); text-align: center;
        box-shadow: 0 2px 8px rgba(0,0,0,.28), 0 0 0 2px var(--surface);
        cursor: pointer; pointer-events: auto; transform: translate(-50%, -50%);
        transition: transform 100ms cubic-bezier(.2,.8,.2,1);
      }
      .pin:hover { transform: translate(-50%, -50%) scale(1.15); }
      .pin.watched { box-shadow: 0 2px 8px rgba(0,0,0,.28), 0 0 0 2px var(--surface), 0 0 0 6px color-mix(in srgb, var(--agent) 45%, transparent); }
      .pin.new { animation: drop 320ms cubic-bezier(.2,1.2,.3,1); }
      @keyframes drop { from { transform: translate(-50%, -180%) scale(.4); opacity: 0 } }

      .tip {
        position: fixed; z-index: 4; max-width: 300px; pointer-events: auto; display: none;
        background: var(--surface); color: var(--ink); border: 1px solid var(--line);
        border-radius: 10px; box-shadow: var(--shadow); padding: 9px 11px;
        font-size: 12.5px; line-height: 1.45; backdrop-filter: saturate(180%) blur(12px);
      }
      .tip .num { color: var(--accent); font-weight: 700; margin-right: 5px; }
      .tip .del { display: inline-block; margin-top: 7px; color: var(--ink-dim); cursor: pointer; font-size: 11px; }
      .tip .del:hover { color: #e5484d; }

      /* ---------- notes panel ---------- */
      .panel {
        position: fixed; z-index: 5; top: 0; right: 0; bottom: 0; width: 304px; display: none;
        pointer-events: auto; background: var(--surface); color: var(--ink);
        border-left: 1px solid var(--line); box-shadow: var(--shadow);
        backdrop-filter: saturate(180%) blur(12px);
        animation: slide 160ms cubic-bezier(.2,.8,.2,1);
        flex-direction: column;
      }
      @keyframes slide { from { transform: translateX(12px); opacity: 0 } }
      .panel h2 { margin: 0; padding: 14px 14px 10px; font-size: 12px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--ink-dim); display: flex; align-items: center; }
      .panel h2 .close { margin-left: auto; color: var(--ink-dim); font-size: 15px; padding: 0 4px; }
      .panel .list { list-style: none; margin: 0; padding: 0 8px 12px; overflow: auto; flex: 1; }
      .panel .item { display: flex; gap: 9px; padding: 9px 8px; border-radius: 9px; cursor: pointer; align-items: flex-start; }
      .panel .item:hover { background: var(--surface-2); }
      .panel .item .n { background: var(--accent); color: var(--accent-ink); border-radius: 999px; min-width: 19px; height: 19px; font: 700 10px/19px var(--sans); text-align: center; padding: 0 5px; flex: none; }
      .panel .item .body { min-width: 0; flex: 1; }
      .panel .item .c { font-size: 12.5px; line-height: 1.4; }
      .panel .item .s { font: 10px/1.5 var(--mono); color: var(--ink-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .panel .item.gone .c { opacity: .5; }
      .panel .item .s .warn { color: #c2860a; }
      .panel .empty { padding: 18px 14px; color: var(--ink-dim); font-size: 12.5px; line-height: 1.5; }

      /* ---------- toast ---------- */
      .toast {
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: #17171c; color: #fff; border-radius: 999px; padding: 8px 14px;
        font-size: 12.5px; box-shadow: 0 8px 26px rgba(0,0,0,.32);
        display: none; pointer-events: none; animation: pop 140ms cubic-bezier(.2,.8,.2,1);
      }

      /* Nothing here is load-bearing motion — it is all emphasis. Two of these loop forever (the
         armed pulse and the agent's spinner), which is exactly what this setting exists to stop. */
      @media (prefers-reduced-motion: reduce) {
        .hl, .dock, .pop, .pin, .tip, .panel, .toast { transition-duration: 1ms !important; }
        .hl.flash, .pop, .pin.new, .toast,
        .dock.armed .mark, .dock.agent-live .av.agent svg { animation: none !important; }
      }
    </style>

    <div class="hl"><div class="tag"></div></div>
    <div class="marquee"><span class="size"></span></div>

    <div class="dock">
      <button class="toggle"><span class="mark"></span><span class="label">Pinpoint</span><span class="hint"></span></button>
      <button class="stop" title="Stop picking">Stop&nbsp;<kbd>Esc</kbd></button>
      <span class="sep"></span>
      <span class="who" title="">
        <span class="av you" aria-label="you"><svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5Z"/></svg></span>
        <span class="av agent" aria-label="your coding agent"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M12 1.6l1.7 5.2 4.4-3.2-3.2 4.4 5.2 1.7-5.2 1.7 3.2 4.4-4.4-3.2L12 22.4l-1.7-5.2-4.4 3.2 3.2-4.4-5.2-1.7 5.2-1.7-3.2-4.4 4.4 3.2z"/></svg></span>
      </span>
      <span class="agent-say"></span>
      <span class="sep"></span>
      <button class="count"><b>0</b>&nbsp;<span class="cw">notes</span></button>
      <button class="close" title="Hide on this site">&times;</button>
    </div>

    <div class="pop">
      <div class="meta"></div>
      <textarea rows="3"></textarea>
      <div class="row2">
        <button class="send">Send<kbd></kbd></button>
        <button class="ghost copy">Copy</button>
        <button class="ghost cancel">Cancel</button>
        <span class="status"></span>
      </div>
    </div>

    <div class="tip"></div>

    <div class="panel">
      <h2>Notes on this page <button class="close">&times;</button></h2>
      <ul class="list"></ul>
    </div>

    <div class="toast"></div>
  `;
  const ui = {
    hl: shadow.querySelector(".hl"),
    tag: shadow.querySelector(".hl .tag"),
    dock: shadow.querySelector(".dock"),
    marquee: shadow.querySelector(".marquee"),
    marqueeSize: shadow.querySelector(".marquee .size"),
    dockToggle: shadow.querySelector(".dock .toggle"),
    dockStop: shadow.querySelector(".dock .stop"),
    dockHint: shadow.querySelector(".dock .hint"),
    dockCount: shadow.querySelector(".dock .count"),
    dockCountN: shadow.querySelector(".dock .count b"),
    dockCountWord: shadow.querySelector(".dock .count .cw"),
    dockClose: shadow.querySelector(".dock .close"),
    pop: shadow.querySelector(".pop"),
    meta: shadow.querySelector(".pop .meta"),
    text: shadow.querySelector(".pop textarea"),
    send: shadow.querySelector(".pop .send"),
    sendKbd: shadow.querySelector(".pop .send kbd"),
    copy: shadow.querySelector(".pop .copy"),
    cancel: shadow.querySelector(".pop .cancel"),
    status: shadow.querySelector(".pop .status"),
    who: shadow.querySelector(".who"),
    agentSay: shadow.querySelector(".agent-say"),
    tip: shadow.querySelector(".tip"),
    panel: shadow.querySelector(".panel"),
    panelList: shadow.querySelector(".panel .list"),
    panelClose: shadow.querySelector(".panel h2 .close"),
    toast: shadow.querySelector(".toast"),
  };
  ui.sendKbd.textContent = K_SEND;
  ui.text.placeholder = "What should change here?";

  // Inline !important styles on the host, because the shadow ":host { all: initial }" rule would
  // otherwise leave it a static, inline, z-index:auto element — and then any page with its own
  // fixed bar (z-index: 10 is enough) paints straight over our overlay.
  host.style.cssText =
    "position:fixed !important;top:0 !important;left:0 !important;width:0 !important;height:0 !important;" +
    "margin:0 !important;padding:0 !important;border:0 !important;overflow:visible !important;" +
    "pointer-events:none !important;z-index:2147483646 !important;display:block !important;" +
    "transform:none !important;filter:none !important;clip-path:none !important;contain:none !important;";
  (document.documentElement || document.body).appendChild(host);

  // ---------- helpers: selectors, paths, styles, source hints ----------
  // closest() does not cross shadow boundaries, so from inside our own shadow root the host is
  // unreachable and every control we own looked like page content. While picking, that made the
  // document's capture-phase click handler open a comment box on our own Stop button.
  const isOurs = (el) => {
    if (!el) return false;
    if (el === host) return true;
    if (el.getRootNode && el.getRootNode() === shadow) return true;
    return !!el.closest?.("pinpoint-root");
  };

  // ---------- iframe support ----------
  // captureVisibleTab crops in TOP-document viewport coordinates, but inside an iframe our rects
  // are frame-relative. Each frame asks its parent where its own <iframe> box sits; the answers
  // chain up so a frame nested several levels deep still gets a correct absolute offset.
  const isTop = window.top === window;
  let frameOffset = { x: 0, y: 0, at: 0 };

  window.addEventListener("message", async (e) => {
    const d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.__pinpoint === "whereAmI") {
      // A child frame is asking for its position. Find which iframe it came from.
      const frames = [...document.querySelectorAll("iframe, frame")];
      const el = frames.find((f) => f.contentWindow === e.source);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const mine = isTop ? { x: 0, y: 0 } : await askParent();
      e.source.postMessage({ __pinpoint: "youAreAt", token: d.token, x: mine.x + r.left, y: mine.y + r.top }, "*");
    }
  });

  function askParent(timeout = 400) {
    return new Promise((resolve) => {
      const token = Math.random().toString(36).slice(2);
      const done = (v) => { window.removeEventListener("message", on); clearTimeout(t); resolve(v); };
      const on = (e) => {
        if (e.data?.__pinpoint === "youAreAt" && e.data.token === token) done({ x: e.data.x, y: e.data.y });
      };
      const t = setTimeout(() => done({ x: 0, y: 0 }), timeout);
      window.addEventListener("message", on);
      try { window.parent.postMessage({ __pinpoint: "whereAmI", token }, "*"); } catch { done({ x: 0, y: 0 }); }
    });
  }

  async function getFrameOffset() {
    if (isTop) return { x: 0, y: 0 };
    if (Date.now() - frameOffset.at < 1000) return frameOffset;
    const o = await askParent();
    frameOffset = { ...o, at: Date.now() };
    return o;
  }

  const GENERATED = /^(css-|sc-|_|jsx-|svelte-)|[0-9a-f]{6,}|^[A-Za-z0-9_-]*__[A-Za-z0-9_-]+_[A-Za-z0-9]{5,}$/;
  const classCount = new Map();
  function rarity(cls) {
    if (!classCount.has(cls)) {
      let n = 0;
      try { n = document.getElementsByClassName(cls).length; } catch { n = 999; }
      classCount.set(cls, n);
    }
    return classCount.get(cls);
  }
  // "btn btn-sm btn-primary" should identify itself by btn-primary, not by btn: the rarest
  // classes are the ones that actually distinguish this element from its siblings.
  function stableClasses(el) {
    return [...el.classList]
      .filter((c) => c && !GENERATED.test(c))
      .sort((a, b) => rarity(a) - rarity(b))
      .slice(0, 2);
  }

  // Returns the root (document or ShadowRoot) that querySelector should run against for `el`.
  function rootOf(el) {
    const r = el.getRootNode();
    return r instanceof ShadowRoot ? r : document;
  }

  function uniqueSelector(el) {
    const root = rootOf(el);
    const local = uniqueSelectorIn(el, root);
    // Inside a shadow tree: prefix with the host's selector, joined by ">>>" (resolved by safeQuery).
    if (root !== document && root.host) return uniqueSelector(root.host) + " >>> " + local;
    return local;
  }

  // Attributes a framework or a template puts on an element on purpose. These survive a re-render
  // that shuffles sibling order, which positional selectors do not.
  const STABLE_ATTRS = ["data-testid", "data-test", "data-cy", "data-field", "data-action", "data-array",
                        "data-component", "data-id", "data-key", "data-value", "name", "for", "aria-label", "value", "placeholder", "type"];
  function attrCandidates(el) {
    const tag = el.tagName.toLowerCase();
    const out = [];
    for (const a of STABLE_ATTRS) {
      const v = el.getAttribute?.(a);
      if (v && v.length <= 60 && !/["\\]/.test(v)) out.push(`${tag}[${a}="${v}"]`);
    }
    return out;
  }
  function firstUnique(cands, root, el) {
    for (const c of cands) {
      try {
        const hits = root.querySelectorAll(c);
        if (hits.length === 1 && hits[0] === el) return c;
      } catch {}
    }
    return null;
  }

  function uniqueSelectorIn(el, root) {
    if (el.id && root.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    // Try the element's own stable attributes before anything positional.
    const own = firstUnique(attrCandidates(el), root, el);
    if (own) return own;
    // Then the same attributes combined with a distinctive class.
    const cls = stableClasses(el);
    if (cls.length) {
      const withClass = attrCandidates(el).map((c) => c + "." + CSS.escape(cls[0]));
      const hit = firstUnique(withClass, root, el);
      if (hit) return hit;
    }
    // Then an attribute-anchored ancestor plus this element's class, which survives re-ordering.
    for (let p = el.parentElement, hops = 0; p && hops < 4; p = p.parentElement, hops++) {
      const anchor = p.id && root.querySelectorAll(`#${CSS.escape(p.id)}`).length === 1
        ? `#${CSS.escape(p.id)}`
        : firstUnique(attrCandidates(p), root, p);
      if (!anchor) continue;
      const tail = el.tagName.toLowerCase() + (cls.length ? "." + cls.map((c) => CSS.escape(c)).join(".") : "");
      const hit = firstUnique([`${anchor} ${tail}`], root, el);
      if (hit) return hit;
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && root.querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const cls = stableClasses(cur);
      if (cls.length) part += "." + cls.map((c) => CSS.escape(c)).join(".");
      const parent = cur.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((s) => s.tagName === cur.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      try {
        const candidate = parts.join(" > ");
        if (root.querySelectorAll(candidate).length === 1) return candidate;
      } catch {}
      cur = parent;
    }
    return parts.join(" > ");
  }

  function domPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let p = cur.tagName.toLowerCase();
      if (cur.id) p += `#${cur.id}`;
      else {
        const c = stableClasses(cur);
        if (c.length) p += "." + c[0];
      }
      parts.unshift(p);
      const parent = cur.parentElement;
      if (!parent) {
        const r = cur.getRootNode();
        if (r instanceof ShadowRoot && r.host) { parts.unshift("#shadow-root"); cur = r.host; continue; }
      }
      cur = parent;
    }
    return parts.join(" > ");
  }

  const STYLE_PROPS = [
    "display", "position", "width", "height", "padding", "margin", "gap",
    "color", "background-color", "background-image", "border", "border-radius", "box-shadow", "opacity",
    "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "text-transform",
    "flex-direction", "justify-content", "align-items", "grid-template-columns", "overflow", "z-index",
  ];
  function computedStyles(el) {
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of STYLE_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v && v !== "none" && v !== "normal" && v !== "auto" && v !== "0px" && v !== "static" && v !== "visible") out[p] = v;
    }
    return out;
  }

  function pickAttributes(el) {
    const keep = {};
    for (const a of el.attributes) {
      if (/^(id|class|style)$/.test(a.name)) continue;
      if (/^(role|aria-[\w-]+|href|src|alt|name|type|placeholder|title|for|value|data-[\w-]+)$/.test(a.name)) {
        keep[a.name] = a.value.length > 200 ? a.value.slice(0, 200) + "…" : a.value;
      }
    }
    return keep;
  }

  // Framework internals live in the page's MAIN world; inspector.js answers synchronously.
  function sourceHint(el) {
    let result = null;
    const onResult = (e) => { result = e.detail; };
    el.addEventListener("pinpoint:inspect-result", onResult, { once: true });
    el.dispatchEvent(new CustomEvent("pinpoint:inspect", { bubbles: true }));
    el.removeEventListener("pinpoint:inspect-result", onResult);
    try {
      const h = result ? JSON.parse(result) : null;
      if (h && !h.error) return h;
    } catch {}
    return { framework: null, components: [], file: null, line: null, column: null, attributes: {} };
  }

  // A small identity card for the element, so a pin can tell whether the node its selector now
  // matches is really the thing the developer clicked. On pages that rebuild themselves with
  // innerHTML, a positional selector can otherwise silently point at a different element.
  const FP_ATTRS = ["id", "name", "for", "value", "type", "placeholder", "aria-label",
                    "data-testid", "data-field", "data-action", "data-array", "data-component"];
  function fingerprint(el) {
    const attrs = {};
    for (const a of FP_ATTRS) {
      const v = el.getAttribute?.(a);
      if (v) attrs[a] = v.slice(0, 80);
    }
    return { tag: el.tagName.toLowerCase(), text: clip(el.textContent, 60), attrs };
  }
  function fingerprintMatches(el, fp) {
    if (!fp || !el || el.tagName.toLowerCase() !== fp.tag) return false;
    const keys = Object.keys(fp.attrs);
    if (keys.length) return keys.every((k) => (el.getAttribute(k) || "") === fp.attrs[k]);
    return clip(el.textContent, 60) === fp.text;
  }
  // Selector first; if it lands on something else, look for the real element by identity.
  function findElement(selector, fp) {
    const bySelector = safeQuery(selector);
    if (!fp) return bySelector;
    if (bySelector && fingerprintMatches(bySelector, fp)) return bySelector;
    let found = null;
    try {
      for (const el of document.getElementsByTagName(fp.tag)) {
        if (isOurs(el) || !fingerprintMatches(el, fp)) continue;
        if (found) return null; // ambiguous: better no pin than a wrong one
        found = el;
      }
    } catch {}
    return found;
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = stableClasses(el).map((c) => `.${c}`).join("");
    const r = el.getBoundingClientRect();
    return `${tag}${id}${cls}  ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  function clip(s, n) {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  // ---------- highlight ----------
  function moveHighlight(el, cls) {
    if (!el) {
      ui.hl.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(ui.hl.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    ui.hl.className = "hl " + (cls || "");
    ui.tag.textContent = describe(el);
  }

  // ---------- the dock ----------
  // A quiet, always-there marker that Pinpoint is live in this tab, doubling as the on/off switch
  // so you don't have to reach for the keyboard for every note.
  let bridgeOk = false, dockHidden = false, pendingResume = false;
  const HIDE_KEY = "hideDock:" + location.origin;

  // A page whose <html> or <body> carries a transform/filter/will-change becomes the containing
  // block for our fixed bar, so "bottom: 16px" stops meaning the bottom of the window. Measure
  // where it actually landed and nudge it back onto the viewport.
  function keepDockOnScreen() {
    if (!isTop || ui.dock.style.display !== "flex") return;
    ui.dock.style.transform = "none";
    const r = ui.dock.getBoundingClientRect();
    if (!r.width) return;
    const vw = window.innerWidth, vh = window.innerHeight, M = 16;
    const pos = ui.dock.className;
    const wantLeft = /pos-br|pos-tr/.test(pos) ? vw - M - r.width : M;
    const wantTop = /pos-tl|pos-tr/.test(pos) ? M : vh - M - r.height;
    const dx = Math.round(wantLeft - r.left), dy = Math.round(wantTop - r.top);
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) ui.dock.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  // ---------- agent presence ----------
  // The bridge reports what the coding agent last did; the bar shows it the way a shared document
  // shows the other person's cursor, so you can see your notes being worked on.
  let agentState = null, agentTimer = 0;
  function setAgent(a) {
    const known = agentState?.at;
    agentState = a;
    paintAgent();
    clearTimeout(agentTimer);
    if (a) agentTimer = setTimeout(paintAgent, 26000);
    // a resolve is worth calling out, and worth flashing the pin it belongs to
    if (a && a.action === "resolve" && a.at !== known) {
      toast(`Your agent finished ${a.label ? a.label.replace(/^done with /, "") : "a note"}`);
    }
    if (a && a.id && a.action === "look") {
      const p = pins.find((x) => x.id === a.id);
      if (p) { p.node.classList.add("watched"); setTimeout(() => p.node.classList.remove("watched"), 2600); }
    }
  }
  function paintAgent() {
    if (!isTop) return;
    const live = !!agentState && (agentState.secondsAgo ?? 999) < 25 && Date.now() - agentState.seenAt < 26000;
    ui.dock.classList.toggle("agent-live", live);
    ui.agentSay.textContent = live ? (agentState.label || "working") : "";
    ui.who.title = live ? `Your coding agent is ${agentState.label || "working"}` : "You";
    if (live) { clearTimeout(miniTimer); ui.dock.classList.remove("mini"); }
  }

  let miniTimer = 0;
  function expandDock(ms = 4000) {
    ui.dock.classList.remove("mini");
    clearTimeout(miniTimer);
    if (!picking) miniTimer = setTimeout(() => ui.dock.classList.add("mini"), ms);
  }

  function paintDock() {
    if (!isTop) return;
    ui.dock.classList.toggle("armed", picking);
    if (picking) { clearTimeout(miniTimer); ui.dock.classList.remove("mini"); }
    else if (!ui.dock.classList.contains("mini")) expandDock();
    // While armed the Stop button carries the Esc affordance, so the hint just names the action.
    ui.dockHint.innerHTML = picking ? `Click any element` : `<kbd>${MAC ? "\u2325\u21e7A" : "Alt+Shift+A"}</kbd>`;
    ui.dockCountN.textContent = String(pins.length);
    ui.dockCountWord.textContent = pins.length === 1 ? "note" : "notes";
    paintAgent();
    ui.dockCount.style.display = pins.length ? "inline-flex" : "none";
    ui.dock.style.display = bridgeOk && !dockHidden ? "flex" : "none";
    requestAnimationFrame(keepDockOnScreen);
  }

  async function refreshDock() {
    if (!isTop) return;
    try {
      const h = await chrome.runtime.sendMessage({ type: "health" });
      bridgeOk = !!h?.ok;
    } catch { bridgeOk = false; }
    try {
      const v = await chrome.storage.local.get(HIDE_KEY);
      dockHidden = !!v[HIDE_KEY];
    } catch {}
    try {
      const { dockPos } = await chrome.storage.sync.get({ dockPos: "tr" });
      ui.dock.classList.remove("pos-br", "pos-tl", "pos-tr");
      if (dockPos !== "bl") ui.dock.classList.add("pos-" + dockPos);
    } catch {}
    paintDock();
  }

  ui.dock.addEventListener("mouseenter", () => { clearTimeout(miniTimer); ui.dock.classList.remove("mini"); });
  ui.dock.addEventListener("mouseleave", () => { if (!picking) expandDock(1200); });
  ui.dockToggle.addEventListener("click", (e) => { e.stopPropagation(); togglePicking(); });
  ui.dockStop.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); stopPicking(); });
  ui.dockCount.addEventListener("click", (e) => { e.stopPropagation(); togglePanel(); });
  ui.dockClose.addEventListener("click", async (e) => {
    e.stopPropagation();
    dockHidden = true;
    paintDock();
    try { await chrome.storage.local.set({ [HIDE_KEY]: true }); } catch {}
    toast("Hidden on this site — the toolbar icon still works");
  });

  let toastTimer = 0;
  function toast(msg, ms = 2200) {
    ui.toast.textContent = msg;
    ui.toast.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (ui.toast.style.display = "none"), ms);
  }

  // ---------- notes panel ----------
  function togglePanel(force) {
    const open = force !== undefined ? force : ui.panel.style.display !== "flex";
    ui.panel.style.display = open ? "flex" : "none";
    if (open) renderPanel();
  }
  ui.panelClose.addEventListener("click", () => togglePanel(false));

  function renderPanel() {
    ui.panelList.innerHTML = "";
    if (!pins.length) {
      ui.panelList.innerHTML = `<li class="empty">Nothing marked on this page yet. Turn on Pinpoint and click anything you want changed.</li>`;
      return;
    }
    for (const p of pins) {
      const li = document.createElement("li");
      li.className = "item" + (p.node.dataset.orphan === "1" ? " gone" : "");
      li.innerHTML = `<span class="n"></span><div class="body"><div class="c"></div><div class="s"></div></div>`;
      li.querySelector(".n").textContent = p.number;
      li.querySelector(".c").textContent = p.comment;
      li.querySelector(".s").innerHTML = p.node.dataset.orphan === "1"
        ? `<span class="warn">not on this view</span>`
        : escapeHtml(p.selector);
      li.addEventListener("click", () => revealPin(p));
      ui.panelList.appendChild(li);
    }
  }

  function revealPin(p) {
    const el = p.el && p.el.isConnected ? p.el : findElement(p.selector, p.fp);
    if (!el) return toast("That element isn't on the page right now");
    // The CSS media query cannot reach this one — jumping to a note must respect the setting too.
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
    setTimeout(() => {
      moveHighlight(el, "flash");
      ui.hl.classList.add("flash");
      setTimeout(() => { ui.hl.classList.remove("flash"); if (!selected) moveHighlight(null); }, 1000);
    }, 260);
  }

  // ---------- picker ----------
  function startPicking() {
    if (picking) return;
    picking = true;
    document.documentElement.classList.add("pinpoint-picking");
    paintDock();
    hidePopover();
  }
  function stopPicking() {
    picking = false;
    hovered = null;
    pendingResume = false;
    document.documentElement.classList.remove("pinpoint-picking");
    paintDock();
    if (!selected) moveHighlight(null);
  }
  function togglePicking() {
    picking ? stopPicking() : startPicking();
    // Mirror into sibling frames so an element inside an iframe can be picked too.
    try { chrome.runtime.sendMessage({ type: "mirrorPicking", picking }); } catch {}
  }

  function targetFromEvent(e) {
    const path = e.composedPath ? e.composedPath() : [e.target];
    for (const n of path) {
      if (n && n.nodeType === 1 && !isOurs(n) && n !== document.documentElement && n !== document.body) return n;
    }
    return null;
  }

  let hoverTimer = 0;
  document.addEventListener("mousemove", (e) => {
    if (!picking) return;
    const t = targetFromEvent(e);
    if (t && t !== hovered) {
      hovered = t;
      moveHighlight(t);
      // Walking framework internals is too costly for every mousemove, so the component name
      // is filled in once the pointer settles.
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (!picking || hovered !== t) return;
        const c = sourceHint(t).components[0];
        if (c && hovered === t) ui.tag.textContent = `<${c}>  ` + describe(t);
      }, 90);
    }
  }, true);

  document.addEventListener("click", (e) => {
    if (!picking) return;
    const t = targetFromEvent(e);
    if (!t) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    selected = t;
    stopPicking();
    moveHighlight(t, "selected");
    openPopover(t);
  }, true);

  // ---------- region selection ----------
  // Click takes one element; drag takes an area. A box has no element of its own, so it is
  // anchored to the deepest element that fully contains it — which is what lets the pin re-find
  // itself after a re-render, exactly as an element pin does, and gives the agent a real
  // container to edit rather than four loose coordinates.
  let selectedRegion = null;
  let dragFrom = null, dragging = false;

  const boxOf = (a, b) => ({
    left: Math.min(a.x, b.x), top: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y),
  });

  // What did the box ENCLOSE? — not what encloses the box.
  //
  // Two earlier rules were wrong, both reproduced in test/site/region.html:
  //   1. "the deepest element that fully CONTAINS the box" — nobody drags pixel-perfect, so a box
  //      drawn generously around a card is contained by no card and the search reached <main>.
  //   2. "the outermost element that is ≥60% covered" — a short page container is itself mostly
  //      covered, and being outermost it swallowed the card inside it.
  //
  // The rule that holds: the SMALLEST element that accounts for at least half the box. Share is
  // measured against the box, so a candidate must already be about the size of what was drawn —
  // which rules out incidental slivers — and taking the smallest such element keeps the most
  // specific one. Span three cards and no single card reaches half, so their grid wins instead.
  function anchorFor(box) {
    const bx2 = box.left + box.width, by2 = box.top + box.height;
    const boxArea = box.width * box.height || 1;
    const shareOfBox = (r) => {
      const w = Math.min(r.right, bx2) - Math.max(r.left, box.left);
      const h = Math.min(r.bottom, by2) - Math.max(r.top, box.top);
      return w > 0 && h > 0 ? (w * h) / boxArea : 0;
    };

    let best = null, bestArea = Infinity;
    let fallback = null, fallbackShare = 0;
    for (const el of document.body.querySelectorAll("*")) {
      if (isOurs(el)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < 100) continue;                       // hairlines and empty wrappers
      const share = shareOfBox(r);
      if (share > fallbackShare) { fallbackShare = share; fallback = el; }
      if (share >= 0.5 && area < bestArea) { best = el; bestArea = area; }
    }
    return best || fallback || document.body;
  }

  // The outermost elements wholly inside the box — what the region actually contains, without
  // listing every descendant of every card.
  function containedIn(anchor, box, limit = 12) {
    const out = [];
    for (const el of anchor.querySelectorAll("*")) {
      if (out.length >= limit) break;
      if (isOurs(el)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.left >= box.left - 1 && r.top >= box.top - 1 &&
          r.right <= box.left + box.width + 1 && r.bottom <= box.top + box.height + 1 &&
          !out.some((o) => o.contains(el))) out.push(el);
    }
    return out;
  }

  // Pointer events, not mouse events: the suppression block below preventDefaults pointerdown,
  // and per spec that cancels the compatibility mousedown/mouseup/click that would otherwise
  // follow — so a mousedown listener here would never fire at all.
  document.addEventListener("pointerdown", (e) => {
    if (!picking || isOurs(e.target)) return;
    dragFrom = { x: e.clientX, y: e.clientY };
    dragging = false;
  }, true);

  document.addEventListener("pointermove", (e) => {
    if (!picking || !dragFrom) return;
    const to = { x: e.clientX, y: e.clientY };
    if (!dragging && Math.hypot(to.x - dragFrom.x, to.y - dragFrom.y) < 6) return;
    dragging = true;
    ui.hl.style.display = "none";           // one selection idiom at a time
    const b = boxOf(dragFrom, to);
    Object.assign(ui.marquee.style, {
      display: "block", left: b.left + "px", top: b.top + "px",
      width: b.width + "px", height: b.height + "px",
    });
    ui.marqueeSize.textContent = `${Math.round(b.width)} × ${Math.round(b.height)}`;
  }, true);

  document.addEventListener("pointerup", (e) => {
    if (!picking || !dragFrom) return;
    const from = dragFrom;
    dragFrom = null;
    if (!dragging) return;                  // a plain click — the click handler owns it
    dragging = false;
    ui.marquee.style.display = "none";
    const box = boxOf(from, { x: e.clientX, y: e.clientY });
    if (box.width < 12 || box.height < 12) return;   // a twitch, not a drag
    const anchor = anchorFor(box);
    const inside = containedIn(anchor, box);
    const ar = anchor.getBoundingClientRect();
    selected = anchor;
    selectedRegion = {
      x: Math.round(box.left + window.scrollX), y: Math.round(box.top + window.scrollY),
      width: Math.round(box.width), height: Math.round(box.height),
      // offset within the anchor, so the pin can be replaced after the DOM is rebuilt
      dx: Math.round(box.left - ar.left), dy: Math.round(box.top - ar.top),
      contains: inside.map((el) => ({ tag: el.tagName.toLowerCase(), selector: uniqueSelector(el), text: clip(el.innerText || "", 60) })),
    };
    stopPicking();
    moveHighlight(anchor, "selected");
    openPopover(anchor, selectedRegion);
  }, true);

  ["mousedown", "mouseup", "pointerdown", "pointerup"].forEach((ev) =>
    document.addEventListener(ev, (e) => {
      if (picking && targetFromEvent(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true)
  );

  let escArmed = false;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (ui.panel.style.display === "flex" && !picking && ui.pop.style.display !== "block") return togglePanel(false);
      if (picking) return stopPicking();
      if (ui.pop.style.display === "block") {
        // Don't throw away typed text on a stray Esc.
        if (ui.text.value.trim() && !escArmed) {
          escArmed = true;
          setStatus("Press Esc again to discard", "err");
          return;
        }
        escArmed = false;
        return hidePopover();
      }
    }
    if (e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === "KeyA") {
      e.preventDefault();
      e.stopImmediatePropagation();
      togglePicking();
    }
  }, true);

  // ---------- popover ----------
  function openPopover(el, region = null) {
    const r = region
      ? { left: region.x - window.scrollX, top: region.y - window.scrollY,
          right: region.x - window.scrollX + region.width, bottom: region.y - window.scrollY + region.height }
      : el.getBoundingClientRect();
    const hint = sourceHint(el);
    const comp = hint.components[0] ? `<b>&lt;${hint.components[0]}&gt;</b> ` : "";
    const file = hint.file ? ` · ${hint.file}${hint.line ? ":" + hint.line : ""}` : "";
    const label = clip(el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "", 46);
    ui.meta.innerHTML = region
      ? `<div class="row"><b>Region</b> ${region.width}×${region.height} in ${escapeHtml(describe(el))}${escapeHtml(file)}</div>` +
        `<div class="picked">${region.contains.length} element${region.contains.length === 1 ? "" : "s"} inside</div>`
      : `<div class="row">${comp}${escapeHtml(describe(el))}${escapeHtml(file)}</div>` +
        (label ? `<div class="picked">“${escapeHtml(label)}”</div>` : "");
    ui.text.value = "";
    ui.status.textContent = "";
    ui.status.className = "status";
    ui.pop.style.display = "block";
    const W = 340, H = ui.pop.offsetHeight || 170, M = 8;
    let left = Math.min(Math.max(M, r.left), window.innerWidth - W - M);
    let top = r.bottom + M;
    if (top + H > window.innerHeight - M) top = Math.max(M, r.top - H - M);
    Object.assign(ui.pop.style, { left: left + "px", top: top + "px" });
    ui.send.title = `Send to your coding agent (${K_SEND})`;
    ui.text.placeholder = region
      ? `What should change about this area? e.g. make these cards two-up on mobile — ${K_SEND} to send`
      : `What should change here? e.g. make this button full-width on mobile — ${K_SEND} to send`;
    setTimeout(() => ui.text.focus(), 0);
  }
  function hidePopover() {
    selectedRegion = null;
    escArmed = false;
    ui.pop.style.display = "none";
    selected = null;
    moveHighlight(null);
  }
  ui.cancel.addEventListener("click", () => { hidePopover(); startPicking(); });
  ui.text.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
    e.stopPropagation();
  });
  ui.send.addEventListener("click", submit);
  ui.copy.addEventListener("click", async () => {
    if (!selected) return;
    const a = await buildAnnotation(selected, ui.text.value.trim());
    await navigator.clipboard.writeText(formatPrompt(a));
    setStatus("Copied prompt", "ok");
  });

  function resumePicking() {
    if (!pendingResume) return;
    pendingResume = false;
    startPicking();
    toast("Sent ✓ — still picking, Esc when you're done", 1800);
  }

  function setStatus(msg, cls) {
    ui.status.textContent = msg;
    ui.status.className = "status " + (cls || "");
  }

  // ---------- annotation payload ----------
  // Where to crop, in top-document viewport coordinates. The worker takes the picture, so a page
  // that navigates the instant it sees "Sent ✓" still gets its screenshot.
  async function captureRect(el, override = null) {
    // A region crops to its own box; an element crops to the element.
    const r = override
      ? { left: override.x - window.scrollX, top: override.y - window.scrollY, width: override.width, height: override.height }
      : el.getBoundingClientRect();
    const off = await getFrameOffset();
    const rect = {
      x: Math.max(0, r.left) + off.x, y: Math.max(0, r.top) + off.y,
      width: Math.min(r.width, window.innerWidth - Math.max(0, r.left)),
      height: Math.min(r.height, window.innerHeight - Math.max(0, r.top)),
    };
    if (rect.width < 2 || rect.height < 2) return null;
    return { rect, dpr: window.devicePixelRatio || 1 };
  }

  // Our own overlay must not appear in the crop.
  let restoreTimer = 0;
  function hideOverlayForCapture() {
    // Synchronous: the message must go out in this same tick, so that a page which navigates
    // immediately afterwards has already handed the request to the worker.
    host.style.display = "none";
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(showOverlay, 8000); // safety net if the worker never answers
  }
  function showOverlay() {
    clearTimeout(restoreTimer);
    host.style.display = "";
  }

  async function buildAnnotation(el, comment, opts = {}) {
    const r = el.getBoundingClientRect();
    const a = {
      id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())).slice(0, 8),
      createdAt: new Date().toISOString(),
      comment,
      page: { url: location.href, title: document.title, viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 }, scroll: { x: window.scrollX, y: window.scrollY } },
      element: {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: [...el.classList],
        selector: uniqueSelector(el),
        domPath: domPath(el),
        text: clip(el.innerText || el.textContent, 200),
        outerHTML: clip(el.outerHTML, 600),
        attributes: pickAttributes(el),
        rect: { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), width: Math.round(r.width), height: Math.round(r.height) },
        styles: computedStyles(el),
        fingerprint: fingerprint(el),
      },
      source: sourceHint(el),
      screenshot: null,
    };
    // A region annotation is an element annotation on its anchor, plus the box. Everything
    // downstream — selector, fingerprint, pin re-finding, styles — keeps working unchanged.
    if (opts.region) a.region = opts.region;
    return a;
  }

  function formatPrompt(a) {
    const s = a.source || {};
    const lines = [
      `## UI change request`,
      ``,
      `**Change:** ${a.comment || "(no comment)"}`,
      ``,
      `**Page:** ${a.page.url}`,
      `**Element:** \`${a.element.selector}\``,
      `**DOM path:** ${a.element.domPath}`,
    ];
    if (a.element.text) lines.push(`**Text:** "${a.element.text}"`);
    if (s.components?.length) lines.push(`**Component chain (${s.framework}):** ${s.components.join(" ← ")}`);
    if (s.file) lines.push(`**Source:** ${s.file}${s.line ? ":" + s.line : ""}`);
    lines.push(`**Size:** ${a.element.rect.width}×${a.element.rect.height}px at viewport ${a.page.viewport.width}×${a.page.viewport.height}`);
    const st = Object.entries(a.element.styles).map(([k, v]) => `${k}: ${v}`).join("; ");
    if (st) lines.push(``, `**Computed styles:** ${st}`);
    lines.push(``, "```html", a.element.outerHTML, "```");
    return lines.join("\n");
  }

  async function submit() {
    if (!selected) return;
    const comment = ui.text.value.trim();
    if (!comment) {
      setStatus("Write a comment first", "err");
      ui.text.focus();
      return;
    }
    const el = selected;
    setStatus("Sending…");
    ui.send.disabled = true;
    try {
      const region = selectedRegion;
      const a = await buildAnnotation(el, comment, region ? { region } : {});
      const capture = await captureRect(el, region);
      if (capture) hideOverlayForCapture();
      // The worker stores the comment first and answers immediately, then takes and attaches the
      // crop on its own. Nothing here is on the page's lifetime.
      const res = await chrome.runtime.sendMessage({ type: "submit", annotation: a, capture });
      if (!res || res.error) { showOverlay(); throw new Error(res?.error || "no response"); }
      addPin({ id: a.id, number: res.number || pins.length + 1, selector: a.element.selector, comment, el, fp: a.element.fingerprint, region, fresh: true });
      setStatus("Sent ✓", "ok");
      // The overlay stays hidden until the worker has taken its picture ("captureDone"), which
      // reads as the popover closing the moment you hit send.
      hidePopover();
      // Stay in picking mode so the next note is one click away — no shortcut, no toolbar trip.
      pendingResume = true;
      if (!capture) { showOverlay(); resumePicking(); }
    } catch (e) {
      // Bridge not running? Fall back to clipboard so nothing is lost.
      try {
        const a = await buildAnnotation(el, comment);
        await navigator.clipboard.writeText(formatPrompt(a));
        setStatus("Bridge offline — prompt copied to clipboard", "err");
      } catch {
        setStatus("Failed: " + (e.message || e), "err");
      }
    } finally {
      ui.send.disabled = false;
    }
  }

  // ---------- pins ----------
  function addPin(p) {
    const node = document.createElement("div");
    node.className = "pin";
    node.textContent = p.number;
    node.title = p.comment;
    node.addEventListener("mouseenter", () => showTip(p, node));
    node.addEventListener("mouseleave", scheduleHideTip);
    shadow.appendChild(node);
    if (p.fresh) {
      node.classList.add("new");
      setTimeout(() => node.classList.remove("new"), 400);
    }
    p.node = node;
    pins.push(p);
    positionAll();
    paintDock();
    if (ui.panel.style.display === "flex") renderPanel();
  }
  function positionPin(p, taken) {
    if (p.el && (!p.el.isConnected || (p.fp && !fingerprintMatches(p.el, p.fp)))) p.el = null;
    const el = p.el || (p.el = findElement(p.selector, p.fp));
    if (!el) {
      p.node.style.display = "none";
      p.node.dataset.orphan = "1";
      return;
    }
    delete p.node.dataset.orphan;
    const r = el.getBoundingClientRect();
    const visible = r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    p.node.style.display = visible ? "block" : "none";
    // Several comments on one element would otherwise land on the same pixel, hiding all but the
    // last. Stack them downwards instead so each stays hoverable and removable.
    // A region pin belongs on the box's corner, not the anchor's — the anchor may be far larger
    // than the area that was marked. The offset was recorded inside the anchor, so it moves with it.
    const anchored = p.region
      ? { right: r.left + p.region.dx + p.region.width, top: r.top + p.region.dy }
      : { right: r.right, top: r.top };
    let x = Math.min(anchored.right, window.innerWidth - 14);
    let y = Math.max(12, anchored.top);
    if (taken) {
      const key = () => Math.round(x) + ":" + Math.round(y);
      let guard = 0;
      while (taken.has(key()) && guard++ < 20) y += 26;
      taken.add(key());
    }
    p.node.style.left = x + "px";
    p.node.style.top = y + "px";
  }
  function safeQuery(sel) {
    try {
      const hops = sel.split(" >>> ");
      let root = document, el = null;
      for (const hop of hops) {
        el = root.querySelector(hop);
        if (!el) return null;
        root = el.shadowRoot || el;
      }
      return el;
    } catch { return null; }
  }
  function positionAll() {
    keepDockOnScreen();
    const taken = new Set();
    pins.forEach((p) => positionPin(p, taken));
    if (selected) moveHighlight(selected, "selected");
  }
  let raf = 0;
  function repositionAll() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      positionAll();
    });
  }
  window.addEventListener("scroll", repositionAll, true);
  window.addEventListener("resize", repositionAll);
  new MutationObserver(repositionAll).observe(document.documentElement, { childList: true, subtree: true, attributes: true });

  let tipTimer = 0;
  function showTip(p, node) {
    clearTimeout(tipTimer);
    ui.tip.innerHTML = `<div><span class="num">#${p.number}</span> ${escapeHtml(p.comment)}</div><span class="del">Remove this note</span>`;
    ui.tip.querySelector(".del").onclick = async () => {
      await chrome.runtime.sendMessage({ type: "delete", id: p.id });
      removePin(p.id);
      ui.tip.style.display = "none";
    };
    ui.tip.style.display = "block";
    const r = node.getBoundingClientRect();
    ui.tip.style.left = Math.min(r.left + 14, window.innerWidth - 330) + "px";
    ui.tip.style.top = r.bottom + 6 + "px";
    ui.tip.onmouseenter = () => clearTimeout(tipTimer);
    ui.tip.onmouseleave = scheduleHideTip;
  }
  function scheduleHideTip() {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => (ui.tip.style.display = "none"), 250);
  }
  function removePin(id) {
    const i = pins.findIndex((p) => p.id === id);
    if (i >= 0) {
      pins[i].node.remove();
      pins.splice(i, 1);
      paintDock();
      if (ui.panel.style.display === "flex") renderPanel();
    }
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // Re-render pending pins for this page on load (they live in the bridge, not the page).
  async function loadPins() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "list", url: location.href.split("#")[0] });
      if (!res || !res.annotations) return;
      pins.forEach((p) => p.node.remove());
      pins = [];
      for (const a of res.annotations) addPin({ id: a.id, number: a.number, selector: a.element.selector, comment: a.comment, fp: a.element.fingerprint });
      positionAll();
      paintDock();
      setAgent(res.agent ? { ...res.agent, seenAt: Date.now() } : null);
      if (ui.panel.style.display === "flex") renderPanel();
    } catch {}
  }
  loadPins();
  refreshDock();
  // Cheap retry so the dock appears on pages that were open before you started the bridge.
  setInterval(() => { if (isTop && !bridgeOk && !dockHidden) refreshDock(); }, 6000);
  // The background worker pushes "reloadPins" when the bridge changes; these are the belt-and-braces
  // paths for a tab that was backgrounded while the worker was asleep.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadPins(); refreshDock(); } });
  window.addEventListener("focus", () => { loadPins(); refreshDock(); });

  // Test hook: dispatch "pinpoint:debug-selector" on any element to get {selector, domPath} back.
  document.addEventListener("pinpoint:debug-selector", (e) => {
    const el = e.composedPath()[0];
    if (el?.nodeType !== 1) return;
    el.dispatchEvent(new CustomEvent("pinpoint:debug-selector-result", { detail: JSON.stringify({ selector: uniqueSelector(el), domPath: domPath(el) }) }));
  }, true);

  // ---------- messages from popup / background ----------
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.type === "togglePicker") { togglePicking(); reply({ picking }); }
    else if (msg.type === "startPicker") { startPicking(); reply({ picking }); }
    else if (msg.type === "setPicking") { msg.picking ? startPicking() : stopPicking(); reply({ picking }); }
    else if (msg.type === "captureDone") { showOverlay(); resumePicking(); reply({ ok: true }); }
    else if (msg.type === "reloadPins") { loadPins().then(() => { refreshDock(); reply({ ok: true }); }); return true; }
    else if (msg.type === "showDock") { chrome.storage.local.remove(HIDE_KEY).finally(() => { dockHidden = false; refreshDock(); reply({ ok: true }); }); return true; }
    else if (msg.type === "clearPins") { pins.forEach((p) => p.node.remove()); pins = []; reply({ ok: true }); }
    else if (msg.type === "ping") reply({ ok: true, picking, pins: pins.length });
  });
})();
