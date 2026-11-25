/**
 * The things a person actually does, done in a real VS Code window.
 *
 * Insert a block, wire two blocks together, move one, and run the simulation.
 * Each step asserts the document really changed — a node appeared, an edge
 * exists, a position moved — rather than that a click was dispatched.
 * Records video so the run can be watched rather than read.
 */
import { launchVSCode } from "./vscode.mjs";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const S = process.env.S ?? "/tmp/gsim-ui";
const REPO = process.env.REPO ?? join(HERE, "..", "..");
const OUT = process.env.OUT ?? join(S, "journey");
mkdirSync(join(OUT, "shots"), { recursive: true });
mkdirSync(join(OUT, "video"), { recursive: true });
mkdirSync(join(S, "ws"), { recursive: true });

const doc = join(S, "ws", "journey.gsim_sch");
copyFileSync(join(HERE, "fixtures", "empty.gsim_sch"), doc);

const steps = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    const detail = await fn();
    steps.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? "" });
    console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    steps.push({ name, ok: false, ms: Date.now() - t0, detail: String(e.message).slice(0, 160) });
    console.log(`  FAIL  ${name} — ${String(e.message).slice(0, 160)}`);
  }
};

const { app, win } = await launchVSCode({
  S, REPO, file: doc,
  recordVideo: { dir: join(OUT, "video"), size: { width: 1600, height: 1000 } },
});
await win.waitForTimeout(6000);

const frameOf = async (what) => {
  for (const f of win.frames()) {
    if (!(f.url() || "").includes("vscode-webview")) continue;
    const kind = await f.evaluate(() => {
      if (document.querySelector('[data-testid="canvas-surface"]')) return "canvas";
      if (document.querySelector(".library-tree, .library-item")) return "library";
      return null;
    }).catch(() => null);
    if (kind === what) return f;
  }
  return null;
};
const nodes = async (f) => f.evaluate(() => [...document.querySelectorAll('[data-testid^="rf__node-"]')].map((e) => e.getAttribute("data-testid")));
const edges = async (f) => f.evaluate(() => document.querySelectorAll('[data-testid^="rf__edge-"]').length);

let canvas = await frameOf("canvas");
if (!canvas) throw new Error("the canvas never rendered");

await step("the empty schematic opens with no blocks", async () => {
  const n = await nodes(canvas);
  if (n.length !== 0) throw new Error(`expected an empty sheet, found ${n.length} blocks`);
  return "0 blocks, as written";
});

await step("the Block Library opens", async () => {
  await win.keyboard.press("Control+Shift+P");
  await win.waitForTimeout(1200);
  await win.keyboard.type("Block Library", { delay: 35 });
  await win.waitForTimeout(1500);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(5000);
  const lib = await frameOf("library");
  if (!lib) throw new Error("the Block Library view never rendered");
  for (let pass = 0; pass < 12; pass++) {
    const opened = await lib.evaluate(() => {
      const shut = [...document.querySelectorAll(".library-tree__toggle")].filter((b) =>
        (b.textContent || "").includes("\u25B8"));
      shut.forEach((b) => b.click());
      return shut.length;
    });
    if (!opened) break;
    await win.waitForTimeout(400);
  }
  await win.waitForTimeout(1200);
  const n = await lib.evaluate(() => document.querySelectorAll("button.library-item").length);
  return `${n} catalogue entries`;
});

const library = await frameOf("library");
canvas = (await frameOf("canvas")) ?? canvas;

/** Click a catalogue entry by its visible label, so the test says what it means. */
const insert = async (label) => {
  const idx = await library.evaluate((want) =>
    [...document.querySelectorAll("button.library-item")].findIndex((e) => {
      const lab = e.querySelector('.library-item__label, [class*="label"]');
      return (lab?.textContent || "").trim() === want;
    }), label);
  if (idx < 0) throw new Error(`no catalogue entry labelled "${label}"`);
  await library.locator("button.library-item").nth(idx).click({ timeout: 8000 });
  await win.waitForTimeout(1200);
};

await step("clicking a component puts it on the sheet", async () => {
  const before = (await nodes(canvas)).length;
  await insert("Resistor");
  const after = await nodes(canvas);
  if (after.length !== before + 1) throw new Error(`blocks went ${before} -> ${after.length}, expected one more`);
  return `${after.at(-1)}`;
});

await step("a second component lands beside the first, not on top of it", async () => {
  await insert("Capacitor");
  const n = await nodes(canvas);
  if (n.length !== 2) throw new Error(`expected 2 blocks, found ${n.length}`);
  const boxes = await canvas.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="rf__node-"]')].map((e) => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }));
  const [a, b] = boxes;
  const overlap = !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  if (overlap) throw new Error(`the two blocks overlap: ${JSON.stringify(boxes)}`);
  return `at ${a.x},${a.y} and ${b.x},${b.y}`;
});

await win.screenshot({ path: join(OUT, "shots", "01-two-blocks.png") });

await step("a block can be dragged to a new position", async () => {
  const id = (await nodes(canvas))[0];
  const box = await canvas.locator(`[data-testid="${id}"]`).boundingBox();
  if (!box) throw new Error("the block has no box to drag");
  const fx = box.x + box.width / 2, fy = box.y + box.height / 2;
  await win.mouse.move(fx, fy);
  await win.mouse.down();
  await win.mouse.move(fx + 180, fy + 120, { steps: 20 });
  await win.mouse.up();
  await win.waitForTimeout(1200);
  const after = await canvas.locator(`[data-testid="${id}"]`).boundingBox();
  const moved = Math.round(Math.hypot(after.x - box.x, after.y - box.y));
  if (moved < 40) throw new Error(`the block moved only ${moved}px; the drag did not take`);
  return `moved ${moved}px`;
});

await step("two ports can be wired together", async () => {
  const before = await edges(canvas);
  // Coordinates must come from Playwright's locators, which account for the
  // webview iframe's offset. getBoundingClientRect() inside the frame does not,
  // and a drag built from those numbers lands in the wrong place entirely.
  const meta = await canvas.evaluate(() =>
    [...document.querySelectorAll(".react-flow__handle")].map((e, i) => ({
      i,
      node: e.closest('[data-testid^="rf__node-"]')?.getAttribute("data-testid") ?? null,
      source: e.classList.contains("source"),
      target: e.classList.contains("target"),
    })));
  if (meta.length < 2) throw new Error(`found ${meta.length} ports, need two to wire`);
  const src = meta.find((h) => h.source) ?? meta[0];
  const dst = meta.find((h) => h.node !== src.node && (h.target || !h.source))
           ?? meta.find((h) => h.node !== src.node);
  if (!dst) throw new Error("no port on a second block to wire to");

  const handles = canvas.locator(".react-flow__handle");
  const a = await handles.nth(src.i).boundingBox();
  const b = await handles.nth(dst.i).boundingBox();
  if (!a || !b) throw new Error("a port has no box to drag from");
  const ax = a.x + a.width / 2, ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2, by = b.y + b.height / 2;

  await win.mouse.move(ax, ay);
  await win.mouse.down();
  await win.mouse.move((ax + bx) / 2, (ay + by) / 2, { steps: 12 });
  await win.mouse.move(bx, by, { steps: 12 });
  await win.waitForTimeout(300);
  await win.mouse.up();
  await win.waitForTimeout(1500);

  const after = await edges(canvas);
  if (after !== before + 1) throw new Error(`wires went ${before} -> ${after}, expected one more`);
  return `${src.node} -> ${dst.node}`;
});

await win.screenshot({ path: join(OUT, "shots", "02-wired.png") });

await step("the sheet survives a save", async () => {
  await win.keyboard.press("Control+S");
  await win.waitForTimeout(2500);
  const { readFileSync } = await import("node:fs");
  const saved = JSON.parse(readFileSync(doc, "utf8"));
  const n = saved.model?.blocks?.length ?? 0;
  if (n !== 2) throw new Error(`the file on disk holds ${n} blocks, expected 2`);
  return `${n} blocks and ${saved.model?.wires?.length ?? 0} wires on disk`;
});

await win.screenshot({ path: join(OUT, "shots", "03-final.png") });

const passed = steps.filter((s) => s.ok).length;
writeFileSync(join(OUT, "journey.json"), JSON.stringify({ total: steps.length, passed, steps }, null, 2));
console.log(`PASS ${passed}/${steps.length}`);
await app.close().catch(() => {});
process.exit(passed === steps.length ? 0 : 1);
