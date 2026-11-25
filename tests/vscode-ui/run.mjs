import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Press Run, and check a simulation result actually lands.
 *
 * This is the path a person takes on the day they install the editor: open a
 * worked example, point the setting at a solver, press the button. It asserts
 * files on disk and signals in the viewer, not that a command fired.
 */
import { launchVSCode } from "./vscode.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const S = process.env.S ?? "/tmp/gsim-ui";
const REPO = process.env.REPO ?? join(HERE, "..", "..");
const OUT = process.env.OUT ?? join(S, "run");
const SOLVER = process.env.SOLVER;
if (!SOLVER || !existsSync(SOLVER)) {
  console.log("SOLVER is unset or missing — set it to a general-simulator binary");
  process.exit(2);
}

mkdirSync(join(OUT, "shots"), { recursive: true });
mkdirSync(join(S, "ws"), { recursive: true });
mkdirSync(join(S, "udd-pw", "User"), { recursive: true });

// The one setting a run reads.
writeFileSync(
  join(S, "udd-pw", "User", "settings.json"),
  JSON.stringify(
    {
      "workbench.startupEditor": "none",
      "workbench.editorAssociations": { "*.gsim_sch": "omniSchematics.schematic" },
      "chat.commandCenter.enabled": false,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "security.workspace.trust.enabled": false,
      "window.restoreWindows": "none",
      "extensions.ignoreRecommendations": true,
      "omniSchematics.generalSimulatorPath": SOLVER,
    },
    null,
    2,
  ),
);

const doc = join(S, "ws", "run-buck.gsim_sch");
copyFileSync(join(REPO, "examples", "buck_converter.gsim_sch"), doc);

const steps = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    const detail = await fn();
    steps.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? "" });
    console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    steps.push({ name, ok: false, ms: Date.now() - t0, detail: String(e.message).slice(0, 200) });
    console.log(`  FAIL  ${name} — ${String(e.message).slice(0, 200)}`);
  }
};

const { app, win } = await launchVSCode({ S, REPO, file: doc });
await win.waitForTimeout(7000);

const canvasFrame = async () => {
  for (const f of win.frames()) {
    if (!(f.url() || "").includes("vscode-webview")) continue;
    const yes = await f
      .evaluate(() => !!document.querySelector('[data-testid="canvas-surface"]'))
      .catch(() => false);
    if (yes) return f;
  }
  return null;
};

const canvas = await canvasFrame();
if (!canvas) throw new Error("the canvas never rendered");

await step("the worked example opens with its blocks", async () => {
  const n = await canvas.evaluate(
    () => document.querySelectorAll('[data-testid^="rf__node-"]').length,
  );
  if (n < 5) throw new Error(`expected the buck converter's blocks, found ${n}`);
  return `${n} blocks`;
});

// A run with no folder open lands in the system temp directory, not beside the
// document -- and os.tmpdir() is not always /tmp, which is what made an earlier
// version of this test report a working run as a failure.
const runsRoot = join(tmpdir(), "omni-schematics-runs");
const before = new Set(existsSync(runsRoot) ? readdirSync(runsRoot) : []);

await step("pressing Run starts the solver", async () => {
  const run = canvas.getByRole("button", { name: /^Run$/i }).first();
  if (!(await run.count())) throw new Error("no Run button on the toolbar");
  await run.click({ timeout: 10000 });
  return "clicked";
});

await step("the solver writes a complete result", async () => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await win.waitForTimeout(2000);
    const fresh = (existsSync(runsRoot) ? readdirSync(runsRoot) : []).filter((d) => !before.has(d));
    for (const d of fresh) {
      const dir = join(runsRoot, d);
      const inner = readdirSync(dir);
      const samples = inner.find((f) => f.endsWith(".gsim_samples"));
      const manifest = inner.find((f) => f.endsWith(".gsim_sim_result"));
      if (!samples || !manifest) continue;
      const bytes = statSync(join(dir, samples)).size;
      if (bytes < 10000) continue;
      const m = JSON.parse(readFileSync(join(dir, manifest), "utf8"));
      if (m.data?.kind !== "samples") throw new Error(`manifest says kind=${m.data?.kind}`);
      const signals = m.signals?.length ?? m.data?.signals?.length ?? 0;
      return `${d}: ${bytes.toLocaleString()} bytes, analysis ${m.run?.analysis}, ${signals} signals`;
    }
  }
  throw new Error(`no complete run appeared under ${runsRoot} within 180s`);
});

await win.screenshot({ path: join(OUT, "shots", "after-run.png") });

await step("the viewer lists the signals it solved for", async () => {
  // Checking only that "a canvas exists" passes on the schematic's own canvas,
  // which made an earlier version of this step a false positive.
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    for (const f of win.frames()) {
      if (!(f.url() || "").includes("vscode-webview")) continue;
      const found = await f
        .evaluate(() => {
          const text = document.body.innerText || "";
          const names = [...text.matchAll(/\b(?:V|I)\([a-z0-9_]+\)/gi)].map((m) => m[0]);
          return [...new Set(names)];
        })
        .catch(() => []);
      if (found.length >= 3) return found.slice(0, 5).join(", ");
    }
    await win.waitForTimeout(3000);
  }
  throw new Error("the waveform view never listed any solved signal");
});

await win.screenshot({ path: join(OUT, "shots", "waveform.png") });

const passed = steps.filter((s) => s.ok).length;
writeFileSync(
  join(OUT, "run.json"),
  JSON.stringify({ total: steps.length, passed, steps }, null, 2),
);
console.log(`PASS ${passed}/${steps.length}`);
await app.close().catch(() => {});
process.exit(passed === steps.length ? 0 : 1);
