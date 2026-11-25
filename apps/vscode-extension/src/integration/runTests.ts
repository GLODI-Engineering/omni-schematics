/**
 * Integration-test launcher: downloads (or reuses) a real VS Code build and
 * runs the Mocha suite inside its extension host.
 *
 * Run with `pnpm --filter ./apps/vscode-extension test:integration`. Requires
 * `apps/frontend/dist` to have been built first, and an X display (use
 * `xvfb-run -a` on a headless machine).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runTests } from "@vscode/test-electron";

/**
 * A scratch workspace for the test window: one `.gsim_sch` file plus settings
 * that keep the run hermetic (the kernel test starts the sidecar explicitly).
 */
function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsim-vscode-test-"));
  fs.mkdirSync(path.join(dir, ".vscode"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".vscode", "settings.json"),
    JSON.stringify(
      {
        "omniSchematics.autoStartKernel": false,
        // #141: the kernel starts from a named environment and nothing else, so
        // the suite is handed one or skips the test that needs it. `GSIM_KERNEL_PYTHON`
        // is what CI sets after running `scripts/make-kernel-venv.mjs`; locally,
        // export it to point at the venv you already have.
        ...(process.env.GSIM_KERNEL_PYTHON
          ? { "omniSchematics.kernelPython": process.env.GSIM_KERNEL_PYTHON }
          : {}),
        // #159: the extension runs the solver itself, so the run test needs a
        // binary and nothing else -- no interpreter, no kernel. Named through
        // the setting rather than left to `PATH`, because the setting is the
        // rung a user actually sets and the one whose description used to have
        // to apologise for being read too late to matter.
        ...(process.env.GSIM_GENERAL_SIMULATOR_PATH
          ? { "omniSchematics.generalSimulatorPath": process.env.GSIM_GENERAL_SIMULATOR_PATH }
          : {}),
        "window.restoreWindows": "none",
        "workbench.startupEditor": "none",
        "extensions.autoCheckUpdates": false,
        "telemetry.telemetryLevel": "off",
      },
      null,
      2,
    ),
  );
  // Empty file: the frontend boots its default model, which is enough to prove
  // the custom editor resolved and the React app mounted.
  fs.writeFileSync(path.join(dir, "sample.gsim_sch"), "");
  // A real example, for the run test (#159). Copied rather than opened in
  // place, for the same reason `omniSchematics.openExample` copies: a test
  // that runs a simulation writes `.gsim/runs/` beside the document, and that
  // belongs in a scratch directory rather than in this repository.
  const example = path.resolve(__dirname, "../../../../examples/buck_converter.gsim_sch");
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, path.join(dir, "buck_converter.gsim_sch"));
  }
  return dir;
}

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");

  const frontendDist = path.resolve(extensionDevelopmentPath, "../frontend/dist/schematic.html");
  if (!fs.existsSync(frontendDist)) {
    throw new Error(
      `Built frontend not found at ${frontendDist}. Run "pnpm --filter @gensim/frontend build" first.`,
    );
  }

  const workspace = makeWorkspace();
  console.log(`[integration] test workspace: ${workspace}`);

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    extensionTestsEnv: {
      GSIM_INTEGRATION_TEST: "1",
      GSIM_TEST_WORKSPACE: workspace,
      // Forwarded, not read, by the suite: the setting above is what the
      // extension acts on, and this is how the suite knows whether to expect
      // a kernel at all.
      ...(process.env.GSIM_KERNEL_PYTHON
        ? { GSIM_KERNEL_PYTHON: process.env.GSIM_KERNEL_PYTHON }
        : {}),
      // Same again: forwarded so the suite knows whether to expect a solver,
      // while the setting above is what the extension acts on.
      ...(process.env.GSIM_GENERAL_SIMULATOR_PATH
        ? { GSIM_GENERAL_SIMULATOR_PATH: process.env.GSIM_GENERAL_SIMULATOR_PATH }
        : {}),
    },
    launchArgs: [
      workspace,
      "--disable-extensions",
      "--disable-gpu",
      "--disable-workspace-trust",
      "--no-sandbox",
      "--user-data-dir",
      fs.mkdtempSync(path.join(os.tmpdir(), "gsim-vscode-ud-")),
    ],
  });
}

main().catch((error) => {
  console.error("[integration] failed:", error);
  process.exit(1);
});
