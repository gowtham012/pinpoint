# Privacy

*Last updated: 9 September 2026. This describes Pinpoint 0.4.x — the extension in `extension/` and
the bridge in `bridge/`, as published in this repository.*

Pinpoint is a developer tool that runs on your own machine. There is no Pinpoint account, no Pinpoint
server, and no analytics: the extension's only network destination is a bridge listening on
`127.0.0.1`, which is a process you start yourself.

## What it handles, and only when you mark something

Nothing is collected while you browse. When you click an element (or drag a region) and press Send,
this is assembled and posted to your local bridge:

- **the page** — URL, title, viewport size, scroll position
- **the element** — tag, id, classes, a CSS selector, DOM path, rendered text, trimmed `outerHTML`,
  `role`/`aria-*`/`data-*` attributes, bounding box, about 25 computed style properties, and a
  fingerprint used to re-find the element after a re-render
- **the framework hint** where a dev build exposes it — React/Vue component chain and `file:line`
- **your comment** — the sentence you typed
- **a screenshot** — a PNG cropped to the element, captured by the extension's service worker

## Where it goes

To `http://127.0.0.1:<port>` (7331 by default) and nowhere else. The extension contains no other
network destination — no telemetry endpoint, no remote code, no update service beyond the browser's
own. The bridge refuses any request carrying a web page's `Origin`, and only listens on loopback.

**The one place data leaves Pinpoint is the one you asked for:** the coding agent you connect. Over
MCP, or through the Claude Code hooks, your annotations are handed to Claude Code, Cursor, Codex or
whatever client you configured — and from that point their own terms and privacy policies apply.
Pinpoint has no control over what your agent does with what it is given.

## What is stored, and for how long

- `~/.pinpoint/annotations.json` (or `$PINPOINT_HOME`) — the annotations, with screenshots
  base64-encoded inline rather than as loose image files. Resolved annotations are pruned past 200
  (`PINPOINT_MAX_RESOLVED`); pending ones stay until you resolve or clear them.
- `<your project>/.pinpoint/pending.md` — only when the bridge is run with `--project`. It carries
  its own `.gitignore`, so it stays out of your commits.
- **Browser storage** — settings only: the bridge port, which corner the bar sits in, the sites you
  hid it on, and the path shown in the popup. No page content.

`node bridge/cli.js clear` empties the store. Deleting `~/.pinpoint` and removing the extension
leaves nothing behind.

## Permissions, and why each exists

| Permission | Why |
|---|---|
| `host_permissions: <all_urls>` | Chrome requires a broad host permission for `tabs.captureVisibleTab`, which takes the screenshot. A narrower permission does not grant that API. It is not used to read or inject into pages beyond the local-development matches below. |
| `activeTab`, `scripting` | Show the bar and the picker on the page you are annotating. |
| `tabs` | Know which tab is being captured, and keep pins in sync across tabs showing the same page. |
| `storage` | The settings listed above. |
| `alarms` | Periodically check whether the bridge is running. |
| `nativeMessaging` | Optional. Lets the popup's **Start bridge** button launch this repo's own `cli.js`; it can do nothing else. |

Content scripts are injected automatically only on `localhost`, `127.0.0.1`, `*.localhost`,
`*.local`, `*.test` and `file://` pages. Any other site — including staging and LAN addresses —
requires you to turn Pinpoint on for that tab from the toolbar popup.

## Children

Pinpoint is a developer tool and is not directed at children.

## Questions, and changes to this policy

Open an issue: https://github.com/gowtham012/pinpoint/issues. Changes are made in this file, with the
date at the top; the repository history is the record of what changed and when.
