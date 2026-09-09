# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Found by installing Pinpoint and using it as a first-time user, then reading the code for causes.

### Added
- **`node bridge/cli.js setup` — the whole install in one command.** With `git clone` in front of it
  that is two commands and nothing else: it installs the bridge's dependencies itself (it is written
  to run before `npm install`), then asks, with a default on every question — which project to
  annotate, which of Claude Code, Cursor and Codex to register (merging their config rather than
  replacing it, and backing up Codex's TOML), whether to install the hooks, and which of your
  installed browsers to load the extension into. It opens that browser's extensions page, puts the
  `extension/` path on your clipboard, and then *confirms* the extension connected — the bridge now
  records `extensionSeenAt` and reports it on `/health`. `--yes` runs it unattended; a pipe or a CI
  runner is treated the same way rather than hanging on a prompt. `setup.sh` is now a shim for it.
- **[PRIVACY.md](PRIVACY.md) and [docs/chrome-web-store.md](docs/chrome-web-store.md).** What the
  extension handles, where it is stored, and the one place it leaves by design — the agent you
  connect; plus the packaging, permission justifications and listing copy needed to put the extension
  on the Chrome Web Store, so "Load unpacked" stops being the only way in. The README also says
  plainly what Pinpoint is *not*: a browser-driving agent.
- **Start and restart the bridge from the browser.** `node cli.js install-native-host` registers a
  small native messaging launcher with every Chromium-based browser on the machine; after that the
  popup's **Start bridge** button really starts the process, and while the bridge is running that
  button and the new **↻** in the on-page bar restart it — so picking up a new build no longer
  means going back to a terminal. The launcher can run exactly one thing, this repo's own `cli.js`,
  on a port taken from the popup's own setting: no path, command or project directory crosses that
  boundary. Restart is plain HTTP to the bridge itself, so it needs no launcher and works in Safari.
  macOS and Linux only; on Windows the bridge still starts in a terminal.
- **`/health` reports `cliPath`**, so the popup can print the real command to run instead of a
  `<pinpoint>` placeholder nobody can copy.
- **Agents are told apart.** The MCP handshake carries each client's own name, so with more than one
  connected the bar names the agent that is working (`claude-code`, `cursor-vscode`, `codex`) rather
  than saying "your agent", and each reply in the notes panel is attributed to whoever wrote it
  (`resolvedBy`).

### Changed
- **The extension now pins its id** with a manifest `key`, because native messaging must whitelist
  an exact id and an unpinned one is derived from the install path. **If you already have Pinpoint
  loaded, reload it once** — the id changes, so the popup's port and corner reset to their defaults
  and, if you had turned on *"Allow access to file URLs"*, you must turn it back on. Remove the old
  entry from `chrome://extensions` afterwards. (If Pinpoint is ever submitted to the Chrome Web
  Store, this key must be stripped from the uploaded zip.)

### Fixed
- **Two agents watching at once both got the same note.** `wait_for_annotation` woke every blocked
  waiter with the same annotation, so they duplicated the work and the second `resolve_annotation`
  silently replaced the first agent's reply. Each new note now goes to exactly one waiter, and
  resolving something another agent already finished says so instead of overwriting it quietly.
- **Restarting the bridge froze the pins for 25 seconds at a time.** The extension long-polls
  `/events?since=<n>`, and a restarted bridge starts counting from 1 again — so every poll from a
  client that was ahead sat out the full timeout before returning. A client from a previous life is
  answered at once.
- **The agent's replies were unreachable, so a finished note looked deleted.** The bar's counter is
  the only way into the notes panel, and it hid itself whenever nothing was pending — so the moment
  an agent finished the last note, the reply it had just written could never be opened. The counter
  now stays while there is anything to read and says "1 done" rather than "1 note" when nothing is
  outstanding.
- **The counter was inert while picking.** The whole bar is click-through so it can never block the
  element you are aiming at, and only Stop was exempt — but checking what you have already marked
  is exactly a mid-picking act. It takes clicks now, like Stop.
- **A screenshot could show a different part of the page, with nothing saying so.** The crop was
  measured in viewport coordinates when Send was pressed but taken moments later by the worker, so
  scrolling in between left those coordinates pointing at whatever had moved into that spot — and
  `screenshotSkipped` stayed unset, so the agent received a confident picture of something the
  developer never marked. Worse than no picture. The rect is now also sent in document coordinates
  and re-derived against the page's actual scroll at capture time, so a small scroll still gets a
  correct crop and scrolling away is refused with a reason. (The README already promised this
  behaviour; it was not true.)
- **Clicking Stop also opened a comment box on the bar itself.** `isOurs()` asked
  `el.closest("pinpoint-root")`, and `closest()` does not cross shadow boundaries — so from inside
  our own shadow root every control Pinpoint owns read as page content, and the document's
  capture-phase click handler tried to annotate the Stop button. It only ever showed on Stop
  because that is the one control clickable *while* picking.
- The MCP server announced itself as `0.1.0` while the package was `0.4.0` — the string every MCP
  client shows in its server list. It reads `package.json` now, so the two cannot drift.
- **A region anchored to the whole page instead of the thing you drew around.** Nobody drags
  pixel-perfect: a box drawn generously around a card is contained by no card, so a rule asking for
  the element that *contains* the box reached `<main>`. Asking instead for the outermost mostly-
  covered element fails the same way, because a short page container is itself mostly covered and,
  being outermost, swallows the card inside it. The rule now is **the smallest element that
  accounts for at least half the box**: share is measured against the box, so a candidate must
  already be about the size of what was drawn, and the smallest such element is the most specific
  one. Span three cards and no single card reaches half, so their grid wins instead.
- **`file://` pages were promised but dead.** Chrome keeps *Allow access to file URLs* off per
  extension, so the content script never injected — while `isLocalDev()` returned true for `file:`,
  so the popup offered to annotate and then reported a message asserting `file://` pages work.
- **`install-hooks` broke on any path containing a space**, because the quotes that made the path
  safe were stripped. The install reported success and every prompt failed afterwards.
- **Hook merging deleted unrelated hooks** — ownership was a substring match on `"pinpoint"`, so a
  user's own hook mentioning it, or any repo in a `pinpoint/` folder, was dropped.
- **A flag before a subcommand started a daemon**: `cli.js --port 7332 status` answered by running
  a server instead.
- `install-hooks` errors reached the user as raw stack traces instead of the sentences it writes.
- The origin guard admitted `http://localhost` — the dev site being annotated. `SECURITY.md` and
  the README both said otherwise; the code now matches.
- `setup.sh` defaulted the project to a personal path (`~/Desktop/markus`) in a public repo.
- `content.js` called `captureScreenshot()`, which is defined nowhere. It never fired because
  nothing passes `{screenshot: true}`, but it would have thrown for whoever did. Removed.
- **Windows: the installed hook carried a mangled path.** The path was JSON-escaped rather than
  quoted, so `C:\Users\dev\...` reached the shell as `C:\\Users\\dev\\...`. Windows often
  tolerates doubled separators, but when it does not the only symptom is "Cannot find module" on
  every prompt.
- **The browser suite could not run on a fresh clone.** Playwright ≥1.49 launches
  `chrome-headless-shell` for `headless: true`, which cannot load extensions.
- **`npm test` had never worked** — it hands both files to one `node --test`, which runs them in
  parallel, and both bind port 7399. It is sequential now, matching CI.
- **The bar could land in the wrong place** on pages whose `<html>` carries a transform.
  `keepDockOnScreen()` sets `transform: none` and measures on the next line, but the bar also
  transitioned `transform` over 140ms — so the rect was read mid-animation and the correction was
  computed from the wrong position. It self-corrected on the next pass, which is why it only
  showed up intermittently. The transform is only ever a position fix, never an effect, so the
  transition is gone.

### Changed
- **New logo** — a click: an open ring, the burst of the press, and the cursor coming through the
  gap. Drawn as SVG rather than traced from a raster, so it carries transparency and stays crisp.
  Two cuts on purpose: at 16px the burst strokes and the ring merge into an unreadable blob, so the
  toolbar size drops the burst, thickens the ring and enlarges the cursor. Sources and a
  regeneration script live in `tools/logo/` and `tools/make-icons.sh`. It is violet rather than
  black because a black icon disappears on a dark browser toolbar.
- **Note numbers are per page.** One global counter meant the first note on a new site could read
  "#14", which tells the person looking at it nothing. Each page now numbers from 1, matching the
  pins on screen, the panel titled "Notes on this page", and the counter. Ids stay globally unique
  and remain what an agent resolves by; a number still works as a convenience while it names one
  note, and resolves nothing when it does not — `DELETE /annotations/1` would previously have
  deleted #1 from every page in the store.
- **The bar now opens in the top-right corner** rather than bottom-left, and the popup's corner
  picker opens on the same default.
- **Two hues in the bar instead of three.** "You" was `#a8577f`, a mauve unrelated to anything
  else, so the bar carried violet (h248), mauve (h330) and orange (h18) — three corners of the
  wheel, which is why it read as muddy. "You" is now the same violet as your pins and the brand
  mark; orange stays the agent.
- **The idle agent avatar was an unreadable blob.** Greyscaling the orange fill at 38% produced
  about `#cacaca`, leaving its white glyph at 1.64:1. It is now drawn as an outline — absent
  rather than muddy — at 5.26:1.
- **One optical row.** The bar's children padded 5/10, 5/8, 5/10 and 0/4/0/6 — four rhythms in a
  200px bar. Every control is now 24px tall on a single horizontal rhythm, the separators are
  centred, and the `⌥⇧A` keycap has the size and tracking it needs to be legible at all.
- Your avatar now stacks in front of the agent's, which is what stacked presence means.
- **The on-page bar is no longer dimmed.** Fading it (`.58` at rest, `.4` minified) put the label
  at 4.4:1, the shortcut keycap at 2.34:1 and the minified bar at 2.55:1 against a white page —
  below the 4.5:1 AA floor. Discretion now comes from size and position.
- **Pins, note numbers and the picked-element chip are no longer error red.** White on `#e5484d`
  measured 3.91:1 at 11px bold, and a pending note is not a fault. Red now means only *error* or
  *delete*.
- **Stop is clickable while picking.** The bar stays inert so it can never block the element you
  are aiming at, but clicking Stop no longer falls through and annotates the page behind it.
  (Its first cut was white-on-white — 1.00:1, invisible — because the mockup had a violet bar while
  only the toggle pill actually turns violet. The test now measures the control's contrast, not
  just that it responds.)
- The popup honours `prefers-color-scheme`; it was a white flash in a dark browser.

### Added
- **Safari support.** `tools/make-safari.sh` converts the extension with Apple's
  `safari-web-extension-converter` and builds it — verified end to end here, `BUILD SUCCEEDED`.
  The script bakes in the argument that otherwise wastes an afternoon: the converter derives the
  app id from the last component of `--bundle-identifier`, so if that component does not match the
  app name the extension's id is not a prefix of the app's and Xcode refuses to embed it.
  Safari does not support `"world": "MAIN"` content scripts, so the React/Vue component chain and
  source-file hint are unavailable there; everything else behaves the same.
- Cross-browser namespace shim: Safari and Firefox expose the promise API as `browser`, Chrome as
  `chrome`. Each script now prefers whichever exists, so the ~30 `await chrome.…` calls work on all
  three. `chrome.extension.isAllowedFileSchemeAccess` is Chrome-only and is probed before use.
- **You can see what your agent did.** A finished note used to disappear, leaving you with a
  vanished pin and no idea what changed. It now stays in the notes panel with the agent's reply
  underneath it. That reply is the `note` on `resolve_annotation`, which was optional and so was
  simply skipped — every resolved annotation came back with `resolution: null`. It is required now,
  and the tool says plainly that the developer reads it in their browser and that "done" is not an
  answer. `cli.js resolve` gained `--note` to match; it accepted one internally but never passed it.
- `demo/index.html` — a self-contained demo site for trying Pinpoint and filming it: card grid,
  pricing tiers, near-identical siblings, a tab panel that rebuilds itself, a dense table, a form.
- **Region selection.** Drag instead of clicking to mark an area rather than a single element.
  A box has no element of its own, so it is anchored to the deepest element that fully contains
  it — which is what lets a region pin re-find itself after a re-render exactly as an element pin
  does, and gives the agent a container to edit plus the list of what the box held. The screenshot
  crops to the box.
- README screenshots — the bar idle and picking, the popover, a pin, and a hero shot. Generated
  from the shipped extension by a script that runs its own bridge on a scratch port.
- `prefers-reduced-motion` support — seven animations ran unconditionally, two of them forever.
- README: prerequisites, corrected step order (the bridge blocks the terminal — you need a second
  one), the `file://` permission step, `setup.sh`, and a Troubleshooting section.
- Three tests, taking the suite from 79 to 82: a flag before a subcommand, hooks surviving a path
  with a space (and leaving unrelated hooks alone), and Stop ending a pick with a real mouse click
  while the rest of the bar stays inert.

## [0.4.0] — 2026-09-08

First public release.

### Added
- **Extension** — click any element on a local dev page, type what should change, send it.
  Sticky comment mode, hover outlines naming the React/Vue component, numbered pins that
  live in the bridge (so they survive reloads and appear in every tab showing that page),
  an on-page bar with a notes list and live agent presence, and a per-site corner setting.
- **Bridge** (`127.0.0.1:7331`) — stores annotations in `~/.pinpoint/annotations.json`,
  streams live events to the extension, mirrors pending notes to `<repo>/.pinpoint/pending.md`,
  and prunes resolved annotations past 200 (`PINPOINT_MAX_RESOLVED`).
- **MCP server** over both stdio and Streamable HTTP: `get_pending_annotations`,
  `list_annotations`, `get_annotation`, `resolve_annotation`, `wait_for_annotation`,
  `clear_annotations`, plus the `pinpoint://pending` resource.
- **Claude Code hooks** — `cli.js install-hooks <repo>` wires `SessionStart` and
  `UserPromptSubmit` so pending annotations arrive with your next message, without
  Pinpoint ever being mentioned. Existing settings are preserved; re-running updates
  rather than duplicates.
- **Capture** — element screenshot (element + 8px, long edge ≤1200px) taken by the
  service worker after the comment is stored, so navigating away costs the picture,
  never the note. Selectors prefer stable attributes over positions, and each annotation
  carries a fingerprint so a pin can tell whether its element is still the one you clicked.
- **Offline fallback** — with the bridge down, **Send** copies a ready-to-paste prompt
  to the clipboard.
- 79 tests: bridge/CLI/hooks/MCP on a scratch daemon, and a Chromium suite that loads the
  unpacked extension and drives React, Vue, shadow DOM, an iframe, a strict-CSP page, a
  3,600-node stress page and a form that rebuilds its own DOM.

[0.4.0]: https://github.com/gowtham012/pinpoint/releases/tag/v0.4.0
