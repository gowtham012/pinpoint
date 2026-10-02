// iOS Simulator picking: a native app has no DOM, so the element comes from the accessibility tree
// instead. `xcrun simctl` takes the screenshot and Maestro reads the tree; the page at
// /ios lets you click a node on that screenshot, and what it sends becomes an ordinary annotation —
// MCP, hooks and pending.md never know it did not come from a browser.
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const run = promisify(execFile);

// maestro needs a JVM. Homebrew installs one keg-only, so it is often there but not on PATH.
function maestroEnv() {
  if (process.env.JAVA_HOME) return process.env;
  const jdk = ["/opt/homebrew/opt/openjdk", "/opt/homebrew/opt/openjdk@17", "/usr/local/opt/openjdk"].find((p) => fs.existsSync(p));
  return jdk ? { ...process.env, JAVA_HOME: jdk } : process.env;
}

// Started by the installer, ~/.maestro/bin is often missing from the PATH a launched bridge sees.
const MAESTRO = [path.join(os.homedir(), ".maestro/bin/maestro")].find((p) => fs.existsSync(p)) || "maestro";

// One long-lived `maestro mcp`, not a `maestro hierarchy` per refresh: each CLI run boots a JVM and
// installs and launches the on-device XCUITest driver, ~14s, every time. Kept warm, a read is ~1s.
let maestro = null;
function maestroClient() {
  maestro ||= (async () => {
    const c = new Client({ name: "pinpoint", version: "1" });
    await c.connect(new StdioClientTransport({ command: MAESTRO, args: ["mcp"], env: maestroEnv(), stderr: "ignore" }));
    c.onclose = () => { maestro = null; }; // it died: the next read starts a fresh one
    return c;
  })().catch((e) => { maestro = null; throw e; });
  return maestro;
}

// inspect_screen's compact keys back to the attribute names `maestro hierarchy` uses.
export function fromCompact(el) {
  return {
    attributes: { bounds: el.b, text: el.txt, "resource-id": el.rid, accessibilityText: el.a11y, hintText: el.hint, value: el.val },
    children: (el.c || []).map(fromCompact),
  };
}

async function readTree(udid) {
  // A cold start installs the on-device driver, which can take most of a minute.
  const r = await (await maestroClient()).callTool({ name: "inspect_screen", arguments: { device_id: udid } }, undefined, { timeout: 120000 });
  const text = (r.content || []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
  // The reply can lead with prose (a viewer link, a first-run notice) before the JSON.
  const at = text.indexOf('{"ui_schema"');
  if (r.isError || at < 0) throw new Error(text.trim().split("\n").pop() || "empty reply");
  return { children: JSON.parse(text.slice(at)).elements.map(fromCompact) };
}

// Every Maestro on this machine shares one on-device driver, and another one (an agent's Maestro
// MCP, a test run) restarting it leaves ours talking to a dead driver — "Device became unreachable"
// on every read after, though our process is alive. So a failed read throws the process away and
// tries once more with a fresh one, which brings its own driver up.
async function hierarchy(udid) {
  try { return await readTree(udid); } catch {
    const old = maestro;
    maestro = null;
    (await old?.catch(() => null))?.close().catch(() => {});
    return readTree(udid);
  }
}

// What `setup` checks before pointing anyone at /ios: the three things the picker shells out to.
// Each missing one comes back as a line saying how to get it — nothing is installed for you.
export function iosReadiness() {
  if (process.platform !== "darwin") return ["the iOS Simulator only runs on macOS"];
  const ok = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore", env: maestroEnv() }).status === 0;
  const missing = [];
  if (!ok("xcrun", ["simctl", "help"])) missing.push("Xcode, for the Simulator — install it from the App Store");
  if (!ok(MAESTRO, ["--version"])) missing.push('Maestro, which reads the screen — curl -fsSL "https://get.maestro.mobile.dev" | bash');
  else if (!maestroEnv().JAVA_HOME && !ok("java", ["-version"])) missing.push("Java, which Maestro needs — brew install openjdk@17");
  return missing;
}

export async function bootedDevice() {
  const { stdout } = await run("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
  const d = Object.values(JSON.parse(stdout).devices).flat()[0];
  if (!d) throw new Error("no iOS Simulator is booted — open Simulator.app and launch your app first");
  return { udid: d.udid, name: d.name };
}

// "[x1,y1][x2,y2]" → {x, y, width, height}, in points.
function parseBounds(s) {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(s || "");
  return m ? { x: +m[1], y: +m[2], width: m[3] - m[1], height: m[4] - m[2] } : null;
}

// What a person would call this node: identifier first (it is what greps), then the visible words.
function describe(n) {
  if (n.id) return `#${n.id}`;
  const words = n.label || n.text || n.value;
  return words ? `"${words.length > 40 ? words.slice(0, 40) + "…" : words}"` : "view";
}

// The tree flattened to the nodes you can actually click, each carrying its ancestry so the page
// can hit-test without walking a tree and the annotation can say where the node sits.
export function flatten(tree) {
  const out = [];
  (function walk(node, trail) {
    const a = node.attributes || {};
    const n = {
      id: a["resource-id"] || "",
      label: a.accessibilityText || "",
      text: a.text || a.title || "",
      value: a.value || "",
      hint: a.hintText || "",
      bounds: parseBounds(a.bounds),
    };
    // Unlabelled wrappers are noise in the path; a labelled one is how you would find it again.
    const here = n.id || n.label || n.text ? [...trail, describe(n)] : trail;
    if (n.bounds && n.bounds.width > 0 && n.bounds.height > 0) out.push({ ...n, path: here.join(" > ") || "screen" });
    for (const c of node.children || []) walk(c, here);
  })(tree, []);
  return out;
}

const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

export async function snapshot() {
  const device = await bootedDevice();
  const file = path.join(os.tmpdir(), `pinpoint-ios-${process.pid}.png`);
  const [, tree] = await Promise.all([
    run("xcrun", ["simctl", "io", device.udid, "screenshot", "--type=png", file]),
    hierarchy(device.udid).catch((e) => { throw new Error(`Maestro could not read the screen (is it installed, with Java?): ${e.message}`); }),
  ]);
  const png = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  const nodes = flatten(tree);
  // The screen in points is the window, the first node in the tree. Not the largest or the furthest
  // edge: a scroll view's content runs off-screen and would skew the scale.
  const viewport = { width: nodes[0].bounds.width, height: nodes[0].bounds.height };
  const px = pngSize(png);
  viewport.dpr = Math.round((px.width / viewport.width) * 100) / 100;
  return { device, viewport, nodes, png: png.toString("base64") };
}

const attrEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// A picked node as an annotation in the browser's shape, so every consumer downstream just works.
export function toAnnotation({ node, comment, device, viewport, id }) {
  const attrs = { accessibilityIdentifier: node.id, accessibilityLabel: node.label, text: node.text, value: node.value, hint: node.hint };
  const present = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v));
  const selector = node.id ? `[accessibilityIdentifier="${node.id}"]` : node.label ? `[accessibilityLabel="${node.label}"]` : node.text ? `[text="${node.text}"]` : "view";
  return {
    id,
    comment,
    page: { url: `ios-simulator://${device.name}`, title: `iOS Simulator — ${device.name}`, viewport, scroll: { x: 0, y: 0 } },
    element: {
      tag: "view",
      selector,
      domPath: node.path,
      text: node.text || node.label || "",
      outerHTML: `<view ${Object.entries(present).map(([k, v]) => `${k}="${attrEsc(v)}"`).join(" ")} />`,
      attributes: present,
      rect: node.bounds,
      styles: {},
    },
    // No framework metadata in an accessibility tree: the identifier or the visible text is what to grep.
    source: { framework: "ios-native", components: [], file: null, line: null, attributes: node.id ? { testID: node.id } : {} },
  };
}
