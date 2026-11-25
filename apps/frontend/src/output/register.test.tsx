/**
 * #170: the bottom panel opened onto a tab nothing registered.
 *
 * `focusBottomTab("core.output")` set the panel visible and the active tab to
 * an id with no component, and `BottomPanel` renders the registry's component
 * for the active id — so Run, `Ctrl+Shift+U` and `Ctrl+2` all opened an empty
 * panel with no tab strip, leaving no way to click across to Problems either.
 *
 * The invariant worth encoding is the one the issue names: an id in
 * `BottomTabId` that the registry has no entry for should fail a test rather
 * than render nothing.
 */
import { render } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { registerProblemsSurface } from "../problems/register";
import { BottomPanel } from "../shell/BottomPanel";
import { listBottomTabs, resetBottomTabRegistry } from "../shell/registries/BottomTabRegistry";
import { useIpcStore, useUiStore } from "../store";
import { registerOutputSurface } from "./register";

// Once, not per test: both registration functions guard themselves with a
// module-level flag, exactly as `App.tsx`'s `bootRegistries` relies on, so a
// second `resetBottomTabRegistry()` would leave the registry empty for good.
resetBottomTabRegistry();
registerOutputSurface();
registerProblemsSurface();

beforeEach(() => {
  useIpcStore.setState({ output: [], problems: [] });
  useUiStore.setState({ bottomPanelVisible: false, activeBottomTabId: "core.problems" });
});

describe("the bottom tab registry", () => {
  it("has an entry for every id the shell can focus", () => {
    // `core.waveform` is deliberately absent and is the remaining half of
    // #170: `waveform/register.ts` registers it as an *editor* tab, so the
    // bottom panel has no component for it. That is a separate change — the
    // honest fix is to stop calling it a bottom tab at all, which touches the
    // keymap — and this test names the two that must exist.
    const ids = listBottomTabs().map((tab) => tab.id);
    expect(ids).toContain("core.output");
    expect(ids).toContain("core.problems");
  });
});

describe("focusing the Output tab", () => {
  it("renders the tab, not an empty panel", () => {
    useUiStore.getState().focusBottomTab("core.output");
    const { container } = render(React.createElement(BottomPanel));
    // Before #170 was fixed this was `null` — the whole panel, tab strip
    // included.
    expect(container.querySelector(".bottom-panel")).not.toBe(null);
    expect(container.querySelector(".output-view__empty")).not.toBe(null);
    // And the strip really is there, so Problems can be reached from it.
    expect(container.textContent).toMatch(/Problems/);
  });

  it("shows the lines the editor appended", () => {
    useIpcStore.setState({ output: ["* buck_converter", "vin n_sw_d 0 48"] });
    useUiStore.getState().focusBottomTab("core.output");
    const { container } = render(React.createElement(BottomPanel));
    expect(container.textContent).toContain("vin n_sw_d 0 48");
  });
});
