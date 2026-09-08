# Pinpoint

[![tests](https://github.com/gowtham012/pinpoint/actions/workflows/test.yml/badge.svg)](https://github.com/gowtham012/pinpoint/actions/workflows/test.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

Click an element on your local dev site, write what should change, and your coding agent gets it — with the selector, DOM path, computed styles, React/Vue component chain, source-file hint and a cropped screenshot. No screenshot files piling up in your Downloads folder, no describing "the third button on the left".

```
Browser (extension) ──POST──▶ pinpoint bridge (127.0.0.1:7331) ──MCP / hooks──▶ Claude Code, Cursor, Codex…
        pins ◀──live events───┘   ~/.pinpoint/annotations.json   └── <repo>/.pinpoint/pending.md (optional)
```

## Quick start

You need **Node 18+** and a Chromium browser (Chrome, Arc, Brave or Edge). The `claude` CLI is
only needed for steps 3 and 4.

Everywhere below, replace `~/code/my-app` with **your own project** — the repo whose UI you want
to annotate.

```bash
# 1. get it
git clone https://github.com/gowtham012/pinpoint
cd pinpoint/bridge && npm install
```

```bash
# 2. start the bridge, and leave it running.
#    This blocks the terminal — open a second one for everything below.
node cli.js --project ~/code/my-app
```

**3. Load the extension.** Chrome → `chrome://extensions` → **Developer mode** on →
**Load unpacked** → pick the **`extension/`** folder (one level up from `bridge/`).
The toolbar icon's dot turns green once it can see the bridge.

> Annotating a page you opened as a `file://` URL? Chrome keeps that off by default. On
> `chrome://extensions`, open Pinpoint's **Details** and turn on **"Allow access to file URLs"**,
> then reload the page. Without it Pinpoint cannot appear on `file://` pages at all.

```bash
# 4. teach Claude Code about Pinpoint (once), from pinpoint/bridge
claude mcp add pinpoint -s user -- node "$PWD/cli.js" mcp
node cli.js install-hooks ~/code/my-app     # so annotations arrive without being asked
```

**5. Restart Claude Code once.** Hooks are only read when a session starts.

> **On Windows:** `$PWD` above is a shell variable — it works in PowerShell and Git Bash, but not
> in `cmd.exe`. If you are in `cmd.exe`, run `node cli.js --help` and copy the ready-made
> `claude mcp add …` line it prints at the bottom, which carries the full path already. The
> keyboard shortcuts are `Alt+Shift+A` and `Ctrl+Enter`, and the UI labels them that way for you.
> `setup.sh` is macOS-only; follow the numbered steps instead.

In a hurry? `bash setup.sh ~/code/my-app` from the repo root does steps 1, 2 and 4 in one go
(macOS; it also opens `chrome://extensions` for step 3).

## Where it runs

Pinpoint is a tool for the app you are building, so it only loads itself on local development pages. It appears **on its own** on `localhost`, `127.0.0.1`, and `.local` / `.test` / `.localhost` hosts — plus `file://` pages, once you have granted file access (see the Quick start). On any other site it is simply not there — no bar, no overlay, nothing injected.

Anywhere else — a staging URL, or a private LAN address like `192.168.1.5:3000` when you are testing from your phone — the toolbar popup turns it on for that one tab. Those addresses are recognised as local, but Chrome only injects automatically into the hosts listed above, so the bar will not appear until you opt in from the popup.

## Using it

While the bridge is running, a small bar sits in the corner of every page — that is how you know Pinpoint is live in this tab. Click it (or press **⌥⇧A** / **Alt+Shift+A**) to start marking.

Comment mode stays on. Click an element, type what should change, press **⌘↩** / **Ctrl+Enter**, and you are immediately ready for the next one — no shortcut in between. **Esc** when you are done. While you are marking, the bar goes inert so it can never sit between you and the element you want.

Hovering outlines each element and names its React/Vue component, with a comment cursor so the mode is obvious.

The bar also shows who is present: you, and your coding agent. When the agent reads your notes, opens one, or finishes one, its avatar lights up and the bar says what it is doing — the note it is looking at gets a ring, and a note it completes disappears in front of you. The bar's counter opens a list of everything marked on the page; click a row to jump to it. The **×** hides the bar for that site (the toolbar popup brings it back, and can move it to any corner).

A numbered pin sticks to the element. Pins live in the bridge, not the page, so they survive reloads, appear in every tab showing that page, and vanish the moment your agent marks the change done — no reload needed. On apps that rebuild their DOM (a step change, a route change, a re-render) each pin re-finds its own element by identity, and hides itself rather than sit on a different element that happens to match the old selector.

Then just talk to Claude Code normally. With hooks installed you don't have to mention Pinpoint at all: whatever is pending arrives with your next message. Without hooks, say *"apply my pinpoint annotations"*.

If the bridge isn't running, **Send** copies a ready-to-paste prompt to your clipboard instead, so nothing is lost.

## How your agent finds out

Three mechanisms, strongest first. They stack — using all three is fine.

**Hooks (automatic).** `node cli.js install-hooks <repo>` adds two entries to `<repo>/.claude/settings.json`: a `SessionStart` hook and a `UserPromptSubmit` hook, both running `cli.js print --hook`. That command prints nothing at all when nothing is pending, so a normal session is unaffected. When you have notes, it hands Claude the full detail of anything it has not seen yet, a one-line reminder of anything still outstanding, and an explicit instruction to say what is waiting rather than act on it silently. Net effect: mark something in the browser, type anything in Claude Code, and it comes along. Your own hooks and settings in that file are preserved, and re-running updates rather than duplicates.

Restart Claude Code once after installing — hooks are read when a session starts.

**MCP (on request).** The `pinpoint` MCP server gives the agent `get_pending_annotations`, `wait_for_annotation` and the rest. Its instructions tell the agent to check for annotations whenever you talk about a UI change, so "make that button bigger" usually triggers a lookup on its own.

**A watch loop (hands-off).** Say *"watch pinpoint and apply each change as it comes in"*. The agent parks on `wait_for_annotation`, which returns the instant you hit Send — screenshot included.

## Connecting other agents

Both snippets below need the absolute path to `cli.js`. From `pinpoint/bridge`, run `pwd` and add
`/cli.js` — or just copy the ready-made line that `node cli.js --help` prints at the bottom.
Restart the editor afterwards; MCP servers are read at startup.

**Cursor** — `.cursor/mcp.json` (in the project you are working on, or `~/.cursor/mcp.json` for all of them):
```json
{ "mcpServers": { "pinpoint": { "command": "node", "args": ["/ABS/PATH/pinpoint/bridge/cli.js", "mcp"] } } }
```

**Codex CLI** — `~/.codex/config.toml` (create the file if it does not exist):
```toml
[mcp_servers.pinpoint]
command = "node"
args = ["/ABS/PATH/pinpoint/bridge/cli.js", "mcp"]
```

**Any MCP client over HTTP** — `http://127.0.0.1:7331/mcp` (Streamable HTTP, stateless). Windsurf, Cline, Continue, Zed and Gemini CLI all take a URL.

**No MCP at all** — run the bridge with `--project <repo>` and it keeps `<repo>/.pinpoint/pending.md` current (with its own `.gitignore`, so it stays out of your commits). Tell any agent "read .pinpoint/pending.md and apply it"; it finishes each one with `node cli.js resolve <id>`. Or use the popover's *Copy prompt* / the popup's *Copy all as one prompt* to paste into any chat.

## Commands

Run these from `pinpoint/bridge`.

```
node cli.js [start]            start the bridge (default command)
node cli.js mcp                run as a stdio MCP server
node cli.js status             is it running? how many pending?
node cli.js print              pending annotations as markdown  (--consume also resolves them)
node cli.js resolve <id...>    mark done — the pin disappears in the browser
node cli.js install-hooks [dir]  wire up Claude Code
node cli.js clear              delete everything
node cli.js --help

--port <n>       default 7331, or $PINPOINT_PORT (set the same number in the popup)
--project <dir>  mirror pending annotations into <dir>/.pinpoint/
--print          echo each new annotation to stdout as it arrives
$PINPOINT_HOME   where annotations are stored (default ~/.pinpoint)
```

## MCP tools

| tool | purpose |
|---|---|
| `get_pending_annotations` | everything pending as a markdown task list, each with its screenshot |
| `list_annotations` | one line per annotation |
| `get_annotation` | full detail + screenshot for one id or pin number |
| `resolve_annotation` | mark done → the pin disappears in the browser within a second |
| `wait_for_annotation` | block until the developer sends the next one |
| `clear_annotations` | wipe everything |

Resource: `pinpoint://pending` (markdown).

## What an annotation contains

```
comment          "make this full-width on mobile"          ← the only instruction
page             url, title, viewport, scroll
element          tag, id, classes, a CSS selector built from stable attributes where they exist
                 (`button[data-action="next"]` rather than `:nth-of-type(2)`; shadow DOM via
                 "host >>> inner"), DOM path, rendered text, trimmed outerHTML, role/aria/data-*
                 attributes, bounding box, ~25 computed style properties, and a fingerprint
                 (tag + text + key attributes) used to verify a pin is still on the right element
source           framework (react/vue/svelte/angular/astro), component chain,
                 file:line where the dev build exposes it
screenshot       PNG of just the element (+8px), long edge ≤1200px
```

For exact `file:line` on React 19 or Next, add a dev-only inspector plugin (`vite-plugin-react-inspector`, `@react-dev-inspector`) — Pinpoint reads the `data-source` attributes they emit, as well as React's own `_debugSource`/`_debugStack` and Vue's `__file`.

## Troubleshooting

**No bar appears on the page.** The bar only shows while the bridge is running — that is how it
tells you it is live. Check `node cli.js status` from `pinpoint/bridge`. If the bridge is up but
the bar still isn't there, the page is probably not one Pinpoint injects into automatically (see
*Where it runs*) — open the toolbar popup and turn it on for that tab.

**Nothing at all on a `file://` page.** Chrome keeps file access off per extension. On
`chrome://extensions` → Pinpoint → **Details** → **"Allow access to file URLs"**, then reload.

**The toolbar dot never turns green.** Either the bridge isn't running, or it is on a different
port from the extension. The popup's **Port** field and the bridge's `--port` must match. If
`node cli.js status` says *"port answers, but it is NOT the pinpoint bridge"*, something else owns
that port — start the bridge with `--port 7332` and set 7332 in the popup too.

**`port 7331 is already in use`.** Usually the bridge is already running from another terminal, in
which case you're done. Otherwise pick a free port as above. Don't run two bridges at once: they
share one store file and the last writer wins.

**An annotation has no screenshot.** The picture is taken just after your comment is stored, so
the comment is never lost. If the page navigated or the tab was closed in that moment, the
annotation records why instead of attaching a picture of the wrong page. The comment, selector and
styles are all still there.

**Claude Code doesn't mention my notes.** Hooks are read when a session starts — restart it once
after `install-hooks`. Check that `<your repo>/.claude/settings.json` has two entries containing
`print --hook`, and that the path in them still exists (moving your Pinpoint clone breaks it —
re-run `install-hooks`). You can always just say *"apply my pinpoint annotations"*.

**Nothing works and you want a clean slate.** `node cli.js clear` empties the store;
`~/.pinpoint/annotations.json` is the only state outside your repo.

## Testing

```bash
cd test && npm install && npx playwright install chromium && npm test
```

82 tests. `bridge.test.mjs` (33) runs its own daemon on a scratch port with a temp `PINPOINT_HOME`: validation, filters, the live-event channel, deferred screenshot attachment, the project mirror, loopback/origin guards, persistence across restarts, pruning, every CLI subcommand, hook installation, and every MCP tool over both stdio and Streamable HTTP. `e2e.test.mjs` (49) loads the unpacked extension into headless Chromium and drives real pages: React, Vue, plain HTML with shadow DOM and an iframe, a `default-src 'none'` CSP page, a 3,600-node stress page where every generated selector must resolve back to its own element, DPR 2, cross-tab sync, live resolve, navigating mid-send, switching tabs mid-send, the popup, the on-page bar and its notes list, sticky comment mode, the offline fallback, refusing to load on non-local sites, live agent presence, and a multi-step form that rebuilds its whole DOM with `innerHTML` (where pins must follow their own element or disappear, never silently re-bind to a stranger).

## Notes on safety and storage

The extension only injects itself into local development pages (see *Where it runs*). The broad `<all_urls>` host permission it asks for is required by Chrome for one thing only — `tabs.captureVisibleTab`, the element screenshot — and a narrower permission does not grant it.

The bridge binds to `127.0.0.1` only, identifies itself with a `service` marker (so the extension can't be fooled by another server on the same port), and refuses any request carrying a web page's `Origin` — only `chrome-extension://` callers and local CLI tools get through. A malicious site therefore can't read your annotations or plant instructions for your agent.

Everything scraped from the page (text, HTML, attributes) is explicitly labelled as untrusted data in what the agent receives; only your typed comment is presented as an instruction.

Screenshots are stored base64-encoded inside `~/.pinpoint/annotations.json` rather than as loose image files, and resolved annotations are pruned past 200 (`PINPOINT_MAX_RESOLVED`). The picture is taken by the extension's worker just after your comment is stored, so hitting Send and immediately switching to your editor keeps both; if the page genuinely changed first, the annotation records *why* there is no screenshot instead of attaching one of the wrong page.

## Roadmap

- Mobile: same bridge, picker as an overlay in an Expo dev client or Capacitor webview over LAN.
- CSS source mapping via `chrome.debugger` (which rule set this colour, and where).
- Region and page-level annotations; replies from the agent shown on the pin.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). There is no build step: clone it, `npm install` in `bridge/`, load `extension/` unpacked, and you are developing. Every behaviour change should come with a test; the suite is the reason this thing works on pages that rebuild their own DOM.

## Licence

MIT — see [LICENSE](LICENSE). Release notes live in [CHANGELOG.md](CHANGELOG.md).
