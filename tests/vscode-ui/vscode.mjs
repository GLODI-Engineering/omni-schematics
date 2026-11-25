import pkg from "/home/elvis/node_modules/playwright-core/index.js";
const { _electron } = pkg;

export async function launchVSCode({ S, REPO, file, recordVideo }) {
  // Dropping these two is the whole trick: with WAYLAND_DISPLAY set, Electron
  // ignores DISPLAY and maps no window at all, so VS Code starts and shows nothing.
  const { WAYLAND_DISPLAY: _w, XDG_SESSION_TYPE: _x, ...rest } = process.env;
  const env = { ...rest, DISPLAY: ":99", ELECTRON_OZONE_PLATFORM_HINT: "x11" };
  const args = [
    `--extensionDevelopmentPath=${REPO}/apps/vscode-extension`,
    `--user-data-dir=${S}/udd-pw`,
    `--extensions-dir=${S}/exts-pw`,
    "--ozone-platform=x11",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-workspace-trust",
    "--skip-release-notes",
    "--disable-updates",
    "--disable-telemetry",
  ];
  if (file) args.push(file);
  const opts = { executablePath: "/usr/share/code/code", args, env, timeout: 120000 };
  if (recordVideo) opts.recordVideo = recordVideo;
  const app = await _electron.launch(opts);
  const win = await app.firstWindow({ timeout: 120000 });
  await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1600, 1000);
    w.setPosition(0, 0);
    w.focus();
  });
  // The Copilot sign-in dialog can appear late; keep dismissing for a while.
  for (let i = 0; i < 12; i++) {
    await win.waitForTimeout(2000);
    const btn = win.getByRole("button", { name: /Continue without Signing In/i }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 4000 }).catch(() => {});
      break;
    }
    const alt = win.locator("a,div,span", { hasText: /^Continue without Signing In$/i }).first();
    if (await alt.count().catch(() => 0)) {
      await alt.click({ timeout: 4000 }).catch(() => {});
      break;
    }
  }
  await win.waitForTimeout(2000);
  return { app, win };
}

/** The schematic editor renders in a nested webview iframe. */
export async function schematicFrame(win, { timeout = 60000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const f of win.frames()) {
      const u = f.url() || "";
      if (!u.includes("vscode-webview")) continue;
      // The editor's own root element tells us this is the schematic, not another webview.
      const hit = await f
        .locator("[data-testid], svg, canvas")
        .first()
        .count()
        .catch(() => 0);
      if (hit) return f;
    }
    await win.waitForTimeout(1000);
  }
  return null;
}
