# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- 81 tests: bridge/CLI/hooks/MCP on a scratch daemon, and a Chromium suite that loads the
  unpacked extension and drives React, Vue, shadow DOM, an iframe, a strict-CSP page, a
  3,600-node stress page and a form that rebuilds its own DOM.

[0.4.0]: https://github.com/gowtham012/pinpoint/releases/tag/v0.4.0
