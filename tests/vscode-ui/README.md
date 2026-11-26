# The editor, driven in a real VS Code window

These tests answer the question a person asks after a release — *"if I click the
things, do the right things happen?"* — by driving **the real VS Code** with the
extension loaded, not a browser standing in for it.

That distinction is the point. The rest of the suite tests the webview in a plain
browser, which is wide, uses its own fonts and has none of VS Code's injected CSS
variables. Everything that is wrong about the editor *as a VS Code extension* is
invisible there.

## Running them

```bash
pnpm build && pnpm bundle:webviews        # the extension is loaded from source
Xvfb :99 -screen 0 1600x1000x24 &         # any virtual display will do
S=/tmp/gsim-ui REPO="$PWD" node tests/vscode-ui/sweep.mjs
S=/tmp/gsim-ui REPO="$PWD" node tests/vscode-ui/journey.mjs
```

`REPO` must point at a **built** checkout: VS Code loads the extension from
`$REPO/apps/vscode-extension`, so `out/extension.js` and `media/frontend/` have to
exist. Against a source-only tree every test fails with "the canvas never rendered",
which says nothing about the editor.

Both exit non-zero on failure, write a JSON report to `$OUT` (default `$S/<name>`),
and screenshot anything that fails. `journey.mjs` also records video of the whole run.

Requires `playwright-core` and a VS Code at `/usr/share/code/code` — note that
`/usr/bin/code` is a shell wrapper and will not do.

## What each one covers

**`sweep.mjs`** clicks **every entry in the Block Library** — all 68 — into an empty
schematic and checks the canvas actually gained a block that rendered, with no console
error. It is the broad net: one catalogue entry whose symbol throws, or whose insert
silently does nothing, fails the run and names itself.

**`operating-point.mjs`** asks for an operating point on a 10 V source across two
1 kΩ resistors and asserts the **numbers** — 5 V at the midpoint, 5 mA through the
source — not that a container appeared. A structural check would have passed against
a transient run of the same sheet, which is exactly what this is here to tell apart.

**`journey.mjs`** is one person's path through the editor, with each step asserting the
document really changed rather than that a click was dispatched:

| step | what is actually checked |
|---|---|
| an empty schematic opens | zero blocks, matching the file |
| the Block Library opens | every group expanded, all catalogue entries present |
| clicking a component inserts it | the canvas gains exactly one block |
| a second lands beside the first | the two bounding boxes **do not overlap** |
| a block can be dragged | it moved more than 40 px from where it started |
| two ports can be wired | the edge count rises by one |
| the sheet survives a save | the **file on disk** holds both blocks and the wire |

## Two traps, written down because they cost hours

**This machine runs Wayland.** `WAYLAND_DISPLAY` is set, so Electron ignores `DISPLAY`
and maps no window at all — VS Code starts, logs happily and shows nothing. You must
unset `WAYLAND_DISPLAY` *and* pass `--ozone-platform=x11`. `vscode.mjs` does both.

**Coordinates from inside the webview are not window coordinates.** The editor renders
in a nested iframe, so `getBoundingClientRect()` inside it is relative to that frame.
A drag built from those numbers lands somewhere else entirely — which looked exactly
like "wiring is broken" until the numbers were compared. Use Playwright locators'
`boundingBox()`, which accounts for the frame offset. Both are the same lesson: when
the UI does nothing, suspect the harness before the product.

## Not yet in CI

These need a VS Code binary and a virtual display. The `vscode-extension` job already
runs the integration suite under `xvfb-run`, so the ingredients are there; wiring these
in is tracked separately.
