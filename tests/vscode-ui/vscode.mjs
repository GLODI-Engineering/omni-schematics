import pkg from "/home/elvis/node_modules/playwright-core/index.js";
const { _electron } = pkg;

export async function launchVSCode({ S, REPO, file, recordVideo, profile = "pw" }) {
  // Dropping these two is the whole trick: with WAYLAND_DISPLAY set, Electron
  // ignores DISPLAY and maps no window at all, so VS Code starts and shows nothing.
  const { WAYLAND_DISPLAY: _w, XDG_SESSION_TYPE: _x, ...rest } = process.env;
  const env = { ...rest, DISPLAY: ":99", ELECTRON_OZONE_PLATFORM_HINT: "x11" };
  const args = [
    `--extensionDevelopmentPath=${REPO}/apps/vscode-extension`,
    // A profile of this run's own. Sharing one with another VS Code process
    // makes the new launch attach to the running window instead of starting
    // its own, so the test then measures someone else's build and says nothing
    // changed.
    `--user-data-dir=${S}/udd-${profile}`,
    `--extensions-dir=${S}/exts-${profile}`,
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
  // A fresh profile shows two modals, each of which blocks everything behind it
  // and appears a few seconds in: the Copilot sign-in, and "Make It Yours". A
  // screenshot taken without dismissing them is a picture of VS Code's welcome,
  // not of this extension. Keep looking for both for a while rather than once.
  const dismissals = [/Continue without Signing In/i, /^Get Started$/i, /^Mark Done$/i];
  for (let i = 0; i < 14; i++) {
    await win.waitForTimeout(2000);
    let clicked = false;
    for (const name of dismissals) {
      const btn = win.getByRole("button", { name }).first();
      if (await btn.count().catch(() => 0)) {
        await btn.click({ timeout: 4000 }).catch(() => {});
        clicked = true;
        await win.waitForTimeout(1200);
      }
    }
    const open = await win
      .locator(".monaco-dialog-box, .welcome-view-content")
      .count()
      .catch(() => 0);
    if (!clicked && !open) break;
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
