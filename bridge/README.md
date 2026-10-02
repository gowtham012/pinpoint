# pinpoint-bridge

The local bridge and MCP server behind [Pinpoint](https://github.com/gowtham012/pinpoint): point at
an element in your running app — a page in your browser, or a native app in the iOS Simulator — say
what should change, and your coding agent (Claude Code, Cursor, Codex…) gets your comment with the
selector, DOM path, styles, component chain, source-file hint and a cropped screenshot.

Set it up from the repository — `setup` also loads the browser extension, which is not in this package:

```bash
git clone https://github.com/gowtham012/pinpoint
node pinpoint/bridge/cli.js setup
```

This package is what MCP clients run: `npx -y pinpoint-bridge mcp` is a stdio MCP server that talks
to the running bridge, or reads the saved notes when the bridge is not running. The iOS Simulator
picker is served by the bridge at `http://127.0.0.1:7331/ios`. Everything stays on `127.0.0.1`.

Full documentation: https://github.com/gowtham012/pinpoint#readme
