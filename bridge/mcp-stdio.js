// stdio MCP entrypoint for agents that spawn MCP servers as subprocesses (Claude Code, Cursor, Codex, …).
// It proxies to the running daemon so state is shared with the browser; if the daemon is not running,
// reads fall back to the JSON file and writes are applied to it directly.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp.js";
import { DEFAULT_PORT, load, save } from "./store.js";

export async function startStdio({ port = DEFAULT_PORT } = {}) {
  const base = `http://127.0.0.1:${port}`;
  async function call(path, init) {
    const res = await fetch(base + path, init);
    if (!res.ok) throw new Error(`bridge ${res.status}`);
    return res.json();
  }
  const up = async () => { try { await call("/health"); return true; } catch { return false; } };

  const api = {
    touch(action, id, label) {
      // fire and forget: presence must never slow a tool call down
      fetch(`${base}/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, id, label }) }).catch(() => {});
    },
    async db() {
      if (await up()) {
        const { annotations } = await call("/annotations?status=all&images=1");
        return { annotations };
      }
      return load();
    },
    async resolve(id, note) {
      if (await up()) return (await call(`/annotations/${encodeURIComponent(id)}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note }) })).ok;
      const db = load();
      const a = db.annotations.find((x) => x.id === id || String(x.number) === String(id));
      if (!a) return false;
      a.status = "resolved"; a.resolvedAt = new Date().toISOString(); if (note) a.resolution = note;
      save(db);
      return true;
    },
    async clear() {
      if (await up()) return call("/annotations", { method: "DELETE" });
      save({ nextNumber: 1, annotations: [] });
    },
    async waitForNext(timeoutMs) {
      if (!(await up())) return null;
      const { annotation } = await call(`/annotations/wait?timeout=${timeoutMs}`);
      return annotation;
    },
  };

  const server = createMcpServer(api);
  await server.connect(new StdioServerTransport());
}
