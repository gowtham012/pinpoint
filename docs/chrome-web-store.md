# Chrome Web Store — publisher checklist (Pinpoint MV3)

Practical path to list the open-source Pinpoint extension. No product code changes required for this doc.

Repo: https://github.com/gowtham012/pinpoint · Extension root: `extension/` · Manifest: MV3, version currently in `extension/manifest.json` (e.g. `0.4.0`).

---

## Why CWS matters for growth

- **Discoverability** — “Chrome extension for Claude / Cursor UI” searches land on Store results before random GitHub READMEs.
- **Trust** — “Add to Chrome” beats Load unpacked for many developers who will still run your local bridge.
- **Shareable URL** — PH, Show HN, Twitter, and Reddit can link a Store page without teaching `chrome://extensions` first.
- **Honest residual:** CWS only distributes the extension. The **bridge is still a local Node process** on `127.0.0.1` (default port 7331). Store approval does not replace `npm install` / `node cli.js`.

Until the listing is approved, keep documenting **Load unpacked → `extension/`** as the supported install path (it already is in the README).

---

## Packaging

1. Bump `version` in `extension/manifest.json` when you ship a Store build (semver; CWS rejects reuse of the same version).
2. Zip **only** the `extension/` folder contents (or the folder itself consistently — reviewers open `manifest.json` at the zip root). Do **not** include `bridge/`, `node_modules/`, `.git/`, or test fixtures.
   ```bash
   cd extension && zip -r ../pinpoint-extension-cws.zip . -x '*.DS_Store'
   ```
3. Keep the committed `key` in the manifest if you rely on a stable extension id for native messaging / re-installs; do not strip it casually between builds.
4. Smoke-test the zip: unpack elsewhere → Load unpacked → green toolbar dot with bridge running → pick element on `http://localhost:8080` (`demo/`).

---

## Privacy policy (required URL)

There is **no** `PRIVACY.md` in the repo today — publish one (GitHub Pages, or `docs/privacy.md` / `PRIVACY.md` linked from the listing) before submit.

Verified against the public design / README / manifest (OSS, local-only):

| Claim | Basis |
|-------|--------|
| Local-only processing | Bridge binds `127.0.0.1`; annotations under `~/.pinpoint` (or `$PINPOINT_HOME`) |
| No Pinpoint cloud / no first-party telemetry in OSS path | No analytics host in manifest; no SaaS backend in README architecture |
| Screenshots stay local | Cropped PNG stored base64 in local annotations store; not uploaded by the extension |
| 127.0.0.1 bridge | Extension POSTs to local bridge; MCP/hooks deliver to agents **you** configure |
| Automatic injection limited | Content scripts match localhost / 127.0.0.1 / `.local` / `.test` / `file://`; other sites need popup opt-in |

**Outline to publish:**

1. Overview — developer tool; annotation data processed on your machine.
2. Data the extension handles on your action — page URL/title/viewport, element metadata (selector, DOM path, attributes, styles, component hints), your typed comment, optional cropped screenshot.
3. Where it goes — local bridge (`127.0.0.1`, default 7331); disk under `~/.pinpoint` / optional project `.pinpoint/`. No Pinpoint servers in the OSS design.
4. Third parties — only coding agents / MCP clients **you** connect (Claude Code, Cursor, Codex, etc.); their policies apply after you send data through them.
5. Permissions — `tabs` / `captureVisibleTab` (via host permission), `scripting`, `storage`, `activeTab`, `alarms`, `nativeMessaging` as declared.
6. Children — not directed at children.
7. Contact — GitHub issues: https://github.com/gowtham012/pinpoint/issues
8. Changes — dated policy; same URL for updates.

Do **not** claim “zero data ever leaves the machine” without the agent caveat — MCP/hooks intentionally hand context to the agent.

---

## Host permission justification (`<all_urls>` / `captureVisibleTab`)

Matches the README safety section — use the same story in the Store questionnaire and reviewer notes:

- Chrome requires a broad host permission for `tabs.captureVisibleTab` so Pinpoint can crop a screenshot of the marked element.
- A narrower host permission does **not** grant that capture API.
- Automatic content-script injection is still limited to local development URL patterns in the manifest; non-local tabs require explicit opt-in from the toolbar popup.
- Single purpose: UI annotation for local development → coding agents — not general browsing automation or scraping.

---

## Listing copy

**Name:** Pinpoint — UI annotations for coding agents  
(Manifest name is longer; Store name can be shorter and clearer.)

**Short description** (≤132 characters):

```
Click elements on localhost; send selector, styles, and a cropped screenshot to Claude Code, Cursor, or Codex via a local bridge.
```

**Detailed description** (paste-ready):

```
Pinpoint helps you brief coding agents about UI changes without describing "the third button on the left."

HOW IT WORKS
1. Run the local Pinpoint bridge on your machine (127.0.0.1).
2. Open your local dev site (localhost, 127.0.0.1, .local / .test, or file:// with file access enabled).
3. Click the Pinpoint bar (or press Alt+Shift+A), click an element or drag a region, and write what should change.
4. Your agent receives the CSS selector, DOM path, computed styles, React/Vue component chain, source-file hint, and a cropped screenshot over MCP — or via a pending markdown file / copied prompt.

WHO IT'S FOR
Developers using Claude Code, Cursor, Codex, or any MCP client while building web UIs locally.

WHAT IT IS NOT
Pinpoint does not drive or automate the browser. You point; the coding agent edits. It is not a general web scraper and it does not annotate arbitrary production websites by default.

LOCAL-ONLY
The bridge listens on 127.0.0.1 only. Page content stays on your machine. The extension shows its UI on local development pages; other tabs require explicit opt-in from the popup.

SETUP
This extension expects the open-source Pinpoint bridge (Node 18+). See the project README:
https://github.com/gowtham012/pinpoint

PERMISSIONS (WHY)
• Access to tabs / captureVisibleTab — to crop a screenshot of the element you marked.
• Host access — required by Chrome for tab capture; Pinpoint still limits automatic injection to local development hosts.
• Native messaging (optional) — so the popup can start/restart the local bridge after one-time host install.

Open source (MIT).
```

**Category:** Developer Tools · **Language:** English

---

## Screenshot / promo tile shot list (use existing `docs/images`)

Prefer 1280×800 (or current CWS required sizes). Source assets already in-repo:

| # | Asset | Must show | Avoid |
|---|--------|-----------|-------|
| 1 | `docs/images/bar-idle.png` | Bar idle; localhost URL visible if possible | Random production sites |
| 2 | `docs/images/bar-armed.png` | Picking / outline / Stop | Tiny unreadable UI |
| 3 | `docs/images/popover.png` | Typed instruction + element name | Fake “AI magic” marketing |
| 4 | `docs/images/pin.png` | Numbered pin on element | Cluttered collage |
| 5 | `docs/images/agent-reply.png` | Notes panel + agent reply | Claiming cloud sync |
| 6 | Optional architecture still | Extension → `127.0.0.1:7331` → MCP | Implying SaaS hosting |

**Promo tile / marquee:** “Click the element. Your coding agent gets the context.” + localhost UI. Also usable: `docs/demo.gif` / `docs/demo.mp4` for a short promo video if size limits allow.

---

## Single-purpose policy — risks & phrasing

| Risk | How to phrase / mitigate |
|------|---------------------------|
| Looks like a general-purpose annotator for the whole web | Emphasize **local dev** + coding agents; “not a scraper”; production sites need explicit opt-in |
| Broad `<all_urls>` looks suspicious | Tie exclusively to **screenshot capture**; injection matches are local |
| Native messaging / “Start bridge” | State it only launches **this repo’s** `cli.js`; no remote code download |
| Confusion with Playwright / browser agents | Explicit “does not drive or automate the browser” |
| Over-claiming Store-only features | Same OSS bridge; CWS is distribution + discovery |

Reviewer note (optional paste into submission): *Pinpoint is a developer tool. Host permission exists solely for captureVisibleTab. Content scripts auto-match local development hosts only. The companion Node bridge is open source and loopback-only.*

---

## Step-by-step submit flow

1. Create a [Chrome Web Store Developer](https://chrome.google.com/webstore/devconsole) account (one-time fee).
2. Publish privacy policy URL (see above).
3. Build `pinpoint-extension-cws.zip` from `extension/`.
4. Dev Console → **New item** → upload zip.
5. Fill store listing (name, short + detailed description, category, language).
6. Upload screenshots + promo tile; optional promo video from `docs/demo.mp4`.
7. Answer permission justifications (`host_permissions`, `tabs`, `nativeMessaging`, etc.) with the captureVisibleTab / local-dev story.
8. Single purpose: UI annotation for local development → coding agents.
9. Submit for review. Expect lag; do not block GitHub Load-unpacked docs on approval.
10. After approval: add the Store URL to README / launch posts; keep version bumps in sync with GitHub tags.

---

## What stays “Load unpacked” until approval

- Primary install instructions in README / [quick-install.md](./quick-install.md).
- CI and contributors developing against unpacked `extension/`.
- Anyone who needs a build newer than the last approved Store version.

After approval, dual-path is fine: **Store for discovery**, **Load unpacked / git** for bleeding edge.

---

## Honest residual

The Chrome Web Store item is only the extension. Pinpoint still requires:

- Node 18+ bridge (`pinpoint/bridge`, `node cli.js`)
- Loopback HTTP on `127.0.0.1` (default 7331)
- Optional MCP registration for Claude Code / Cursor / Codex
- Optional `install-native-host` so the popup can start the bridge

CWS does not host or replace that local Node process.
