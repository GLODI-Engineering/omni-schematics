/**
 * Ask for an operating point, and check the editor asked the engine the right
 * question — then that the answer is the one arithmetic gives.
 *
 * The circuit is a 10 V source across two 1 kΩ resistors, so the midpoint is
 * 5 V and the source carries 5 mA, and those are the numbers asserted. A
 * structural check ("a container appeared") would have passed just as well
 * against a transient run of the same sheet, which is the thing this is here
 * to tell apart: before #184 the editor sent every analysis as a transient.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchVSCode } from "./vscode.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const S = process.env.S ?? "/tmp/gsim-ui";
const REPO = process.env.REPO ?? join(HERE, "..", "..");
const SOLVER = process.env.SOLVER;
if (!SOLVER || !existsSync(SOLVER)) {
  console.log("SOLVER is unset or missing — set it to a general-simulator binary");
  process.exit(2);
}

mkdirSync(join(S, "ws"), { recursive: true });
mkdirSync(join(S, "udd-op", "User"), { recursive: true });
const doc = join(S, "ws", "operating-point.gsim_sch");
copyFileSync(join(HERE, "fixtures", "operating-point.gsim_sch"), doc);

const steps = [];
const step = (name, fn) => {
  try {
    const detail = fn();
    steps.push({ name, ok: true });
    console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    steps.push({ name, ok: false });
    console.log(`  FAIL  ${name} — ${String(e.message).slice(0, 180)}`);
  }
};

const runsRoot = join(tmpdir(), "omni-schematics-runs");
const before = new Set(existsSync(runsRoot) ? readdirSync(runsRoot) : []);

const { app, win } = await launchVSCode({ S, REPO, file: doc, profile: "op" });
await win.waitForTimeout(8000);

let canvas = null;
for (const f of win.frames()) {
  if (!(f.url() || "").includes("vscode-webview")) continue;
  const yes = await f
    .evaluate(() => !!document.querySelector('[data-testid="canvas-surface"]'))
    .catch(() => false);
  if (yes) canvas = f;
}
if (!canvas) throw new Error("the canvas never rendered");

await canvas.getByRole("button", { name: /^Run$/i }).first().click({ timeout: 10000 });

let run = null;
const deadline = Date.now() + 120000;
while (Date.now() < deadline && !run) {
  await win.waitForTimeout(2000);
  for (const d of (existsSync(runsRoot) ? readdirSync(runsRoot) : []).filter(
    (x) => !before.has(x),
  )) {
    const dir = join(runsRoot, d);
    const inner = readdirSync(dir);
    const manifest = inner.find((f) => f.endsWith(".gsim_sim_result"));
    const samples = inner.find((f) => f.endsWith(".gsim_samples"));
    if (manifest && samples) run = { dir, manifest, samples };
  }
}
if (!run) throw new Error("no run appeared within 120s");

const manifest = JSON.parse(readFileSync(join(run.dir, run.manifest), "utf8"));

step("the run is recorded as an operating point, not a transient", () => {
  if (manifest.run?.analysis !== "OP") {
    throw new Error(`the manifest says analysis ${manifest.run?.analysis}, expected OP`);
  }
  return "analysis OP";
});

step("it solved one point, not a window", () => {
  // A transient of this sheet runs to tens of kilobytes; one row is hundreds.
  const bytes = statSync(join(run.dir, run.samples)).size;
  if (bytes > 5000)
    throw new Error(`${bytes} bytes of samples looks like a transient, not a point`);
  return `${bytes} bytes`;
});

step("the midpoint is 5 V and the source carries 5 mA", () => {
  const csv = execFileSync(
    SOLVER,
    [join(run.dir, "netlist.cir"), "--mode", "dc", "--format", "csv"],
    {
      encoding: "utf8",
    },
  );
  const [header, row] = csv.trim().split("\n");
  const names = header.split(",");
  const values = row.split(",").map(Number);
  const at = (name) => values[names.indexOf(name)];
  const close = (got, want, tol) => Math.abs(got - want) <= tol;
  // 10 V across 1 kΩ + 1 kΩ. The tolerance is tight because this is arithmetic,
  // not integration: a solver that gets this wrong is not slightly off.
  if (!close(at("V(n_r1_p)"), 10, 1e-9))
    throw new Error(`source node ${at("V(n_r1_p)")} V, expected 10`);
  if (!close(at("V(n_r1_n)"), 5, 1e-9))
    throw new Error(`midpoint ${at("V(n_r1_n)")} V, expected 5`);
  if (!close(at("I(vin)"), -0.005, 1e-12))
    throw new Error(`source current ${at("I(vin)")} A, expected -0.005`);
  return `V=${at("V(n_r1_n)")} V, I=${at("I(vin)")} A`;
});

const passed = steps.filter((s) => s.ok).length;
console.log(`PASS ${passed}/${steps.length}`);
await app.close().catch(() => {});
process.exit(passed === steps.length ? 0 : 1);
