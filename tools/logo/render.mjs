import { chromium } from "/Users/gowthamkumarsolleti/Downloads/pinpoint/test/node_modules/playwright/index.mjs";
import fs from "node:fs";
const svg = fs.readFileSync(process.argv[2], "utf8");
const out = process.argv[3];
const sizes = process.argv.slice(4).map(Number);
const b = await chromium.launch({ channel: "chromium" });
const p = await b.newPage();
for (const s of sizes) {
  await p.setViewportSize({ width: s, height: s });
  await p.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>` +
    svg.replace(/width="\d+"/, `width="${s}"`).replace(/height="\d+"/, `height="${s}"`));
  await p.screenshot({ path: `${out}${s}.png`, omitBackground: true });
  console.log(`  wrote ${out}${s}.png`);
}
// one big preview to actually look at
await p.setViewportSize({ width: 256, height: 256 });
await p.setContent(`<style>html,body{margin:0;background:#fff}svg{display:block}</style>` +
  svg.replace(/width="\d+"/, 'width="256"').replace(/height="\d+"/, 'height="256"'));
await p.screenshot({ path: `${out}-preview.png` });
await b.close();
