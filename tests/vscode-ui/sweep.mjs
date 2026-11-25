/**
 * Every component in the Block Library, clicked, in a real VS Code window.
 *
 * The question this answers is the one a person asks after a release: "if I click
 * each thing in the palette, does the right thing happen?" It inserts each catalogue
 * entry into an empty schematic and checks that the canvas actually gained a block
 * that renders — not that a function was called.
 */
import { launchVSCode } from "./vscode.mjs";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const S = process.env.S ?? "/tmp/gsim-ui";
const REPO = process.env.REPO ?? join(HERE, "..", "..");
const OUT = process.env.OUT ?? join(S, "sweep");

mkdirSync(join(OUT, "shots"), { recursive: true });
mkdirSync(join(S, "ws"), { recursive: true });
const doc = join(S, "ws", "sweep.gsim_sch");
copyFileSync(join(HERE, "fixtures", "empty.gsim_sch"), doc);

const { app, win } = await launchVSCode({ S, REPO, file: doc });
await win.waitForTimeout(6000);

const errors = [];
const findFrames = async () => {
  const out = {};
  for (const f of win.frames()) {
    if (!(f.url() || "").includes("vscode-webview")) continue;
    const kind = await f
      .evaluate(() => {
        if (document.querySelector('[data-testid="canvas-surface"]')) return "canvas";
        if (document.querySelector(".library-tree, .library-item")) return "library";
        return null;
      })
      .catch(() => null);
    if (kind && !out[kind]) out[kind] = f;
  }
  return out;
};
const nodeCount = async (f) =>
  f.evaluate(() => document.querySelectorAll('[data-testid^="rf__node-"]').length).catch(() => -1);

let { canvas } = await findFrames();
if (!canvas) throw new Error("the schematic canvas never rendered");

await win.keyboard.press("Control+Shift+P");
await win.waitForTimeout(1200);
await win.keyboard.type("Block Library", { delay: 35 });
await win.waitForTimeout(1500);
await win.keyboard.press("Enter");
await win.waitForTimeout(5000);

const frames = await findFrames();
canvas = frames.canvas ?? canvas;
const library = frames.library;
if (!library) throw new Error("the Block Library view never rendered");

library.on("pageerror", (e) => errors.push(`library: ${e.message}`));
canvas.on("pageerror", (e) => errors.push(`canvas: ${e.message}`));

// Collapsed groups hide their entries, so open every one first.
for (let pass = 0; pass < 12; pass++) {
  const opened = await library.evaluate(() => {
    const shut = [...document.querySelectorAll(".library-tree__toggle")].filter((b) =>
      (b.textContent || "").includes("▸"),
    );
    shut.forEach((b) => b.click());
    return shut.length;
  });
  if (!opened) break;
  await win.waitForTimeout(400);
}
await win.waitForTimeout(1500);

const labels = await library.evaluate(() =>
  [...document.querySelectorAll("button.library-item")].map((el, i) => {
    const aria = el.getAttribute("aria-label");
    const lab = el.querySelector('[class*="label"], [class*="name"]');
    const text = (aria || lab?.textContent || el.textContent || "").trim().replace(/\s+/g, " ");
    return { i, label: text.slice(0, 60) };
  }),
);
console.log(`catalogue entries found: ${labels.length}`);

const results = [];
for (const { i, label } of labels) {
  const before = await nodeCount(canvas);
  const errsBefore = errors.length;
  let clicked = true;
  try {
    await library.locator("button.library-item").nth(i).click({ timeout: 8000 });
  } catch (e) {
    clicked = false;
    results.push({ label, ok: false, why: `click failed: ${String(e.message).slice(0, 70)}` });
  }
  if (!clicked) continue;
  await win.waitForTimeout(500);
  const after = await nodeCount(canvas);
  const newErrors = errors.slice(errsBefore);
  const ok = after === before + 1 && newErrors.length === 0;
  results.push({
    label,
    ok,
    before,
    after,
    ...(ok ? {} : { why: newErrors[0] ?? `canvas went ${before} -> ${after}, expected +1` }),
  });
  if (!ok) {
    await win.screenshot({ path: join(OUT, "shots", `fail-${String(i).padStart(2, "0")}.png`) }).catch(() => {});
  }
}

await win.screenshot({ path: join(OUT, "shots", "zz-final.png") });
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, "sweep.json"), JSON.stringify({ total: results.length, passed, results }, null, 2));
console.log(`PASS ${passed}/${results.length}`);
for (const f of failed.slice(0, 25)) console.log(`  FAIL  ${f.label}  --  ${f.why}`);
await app.close().catch(() => {});
process.exit(failed.length ? 1 : 0);
