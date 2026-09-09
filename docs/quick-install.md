# Pinpoint — quick install (copy-paste)

Requirements: **Node 18+**, a **Chromium** browser (Chrome, Arc, Brave, Edge, …), and a project folder whose UI you want to annotate (replace paths below).

Repo: https://github.com/gowtham012/pinpoint

---

## 1. Clone + bridge

```bash
git clone https://github.com/gowtham012/pinpoint
cd pinpoint/bridge && npm install
```

Start the bridge and leave it running (second terminal for everything else):

```bash
node cli.js --project /ABS/PATH/TO/YOUR/APP
```

Default listen address: `127.0.0.1:7331`. Override with `--port` / `$PINPOINT_PORT` (match the extension popup).

---

## 2. Load the extension (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the repo’s **`extension/`** folder (sibling of `bridge/`)
4. Toolbar icon dot turns **green** when it can see the bridge

`file://` pages: extension **Details** → enable **Allow access to file URLs**, then reload the page.

---

## 3. Wire your coding agent (MCP)

Replace `/ABS/PATH/pinpoint` with the absolute path to your clone.

### Claude Code

```bash
cd /ABS/PATH/pinpoint/bridge
claude mcp add pinpoint -s user -- node "$PWD/cli.js" mcp
node cli.js install-hooks /ABS/PATH/TO/YOUR/APP
node cli.js install-native-host   # optional: popup "Start bridge"
```

Restart Claude Code once (hooks load at session start).

### Cursor

Project `.cursor/mcp.json` or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "pinpoint": {
      "command": "node",
      "args": ["/ABS/PATH/pinpoint/bridge/cli.js", "mcp"]
    }
  }
}
```

Restart Cursor after saving.

### Codex CLI

`~/.codex/config.toml` (create if missing):

```toml
[mcp_servers.pinpoint]
command = "node"
args = ["/ABS/PATH/pinpoint/bridge/cli.js", "mcp"]
```

### Any MCP client over HTTP

`http://127.0.0.1:7331/mcp` (Streamable HTTP). Or skip MCP: run the bridge with `--project` and tell the agent to read `.pinpoint/pending.md`, or use **Copy prompt** in the UI.

Tip: `node cli.js --help` prints a ready-made MCP line with the full path.

---

## 4. macOS one-shot

From the **repo root** (opens Chrome’s extensions page; starts the bridge):

```bash
bash setup.sh /ABS/PATH/TO/YOUR/APP
```

Then Load unpacked → `extension/` if the extension is not loaded yet. `setup.sh` is macOS-oriented (`open -a "Google Chrome"`); on Windows/Linux use steps 1–3.

---

## 5. Try the demo page

```bash
cd /ABS/PATH/pinpoint/demo && python3 -m http.server 8080
```

Open http://localhost:8080 → Pinpoint bar (top-right) or **Alt+Shift+A** → click an element → type the change → **Ctrl+Enter** / **⌘↩**.

---

## Sanity checks

```bash
cd /ABS/PATH/pinpoint/bridge
node cli.js status
```

More detail: root [README](../README.md) (Quick start, Troubleshooting, Connecting other agents).
