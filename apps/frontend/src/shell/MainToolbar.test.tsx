/**
 * FE-144: MainToolbar horizontal wheel-scroll tests
 * FE-155: MainToolbar simulation time display tests
 *
 * (Ported from the former SpiceToolbar.test.tsx when SpiceToolbar was split
 * into shell/MainToolbar.tsx — always visible, File+Run only — and
 * canvas/SchematicToolbar.tsx — Schematic-tab-only tools.)
 *
 * Acceptance:
 * - A vertical wheel gesture over the toolbar scrolls it horizontally when
 *   it overflows (the toolbar has no visible affordance otherwise at
 *   typical window widths).
 * - No-op when the toolbar isn't overflowing, so normal page scroll isn't
 *   hijacked unnecessarily.
 * - Simulation progress/time display behaves as before the split.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIpcStore } from "../store";
import { useSimSettingsStore } from "../store/sim-settings";
import { useWaveformStore } from "../store/waveform";
import { MainToolbar, formatElapsed } from "./MainToolbar";

afterEach(cleanup);

beforeEach(() => {
  useIpcStore.setState(useIpcStore.getInitialState());
  useSimSettingsStore.setState(useSimSettingsStore.getInitialState());
  useWaveformStore.setState(useWaveformStore.getInitialState());
});

describe("FE-144: MainToolbar horizontal wheel scroll", () => {
  it("test_wheel_scrolls_horizontally_when_overflowing: a vertical wheel gesture scrolls the toolbar horizontally when it overflows", () => {
    const { container } = render(<MainToolbar onAction={() => {}} />);
    const toolbar = container.querySelector(".main-toolbar") as HTMLDivElement;
    expect(toolbar).toBeTruthy();

    // jsdom doesn't compute real layout, so scrollWidth/clientWidth are
    // always 0 by default — simulate an overflowing toolbar explicitly.
    Object.defineProperty(toolbar, "scrollWidth", { value: 2000, configurable: true });
    Object.defineProperty(toolbar, "clientWidth", { value: 1000, configurable: true });
    toolbar.scrollLeft = 0;

    fireEvent.wheel(toolbar, { deltaY: 120 });

    expect(toolbar.scrollLeft).toBe(120);
  });

  it("test_wheel_noop_when_not_overflowing: no horizontal scroll when the toolbar already fits", () => {
    const { container } = render(<MainToolbar onAction={() => {}} />);
    const toolbar = container.querySelector(".main-toolbar") as HTMLDivElement;
    expect(toolbar).toBeTruthy();

    Object.defineProperty(toolbar, "scrollWidth", { value: 800, configurable: true });
    Object.defineProperty(toolbar, "clientWidth", { value: 1000, configurable: true });
    toolbar.scrollLeft = 0;

    fireEvent.wheel(toolbar, { deltaY: 120 });

    expect(toolbar.scrollLeft).toBe(0);
  });
});

describe("FE-155: MainToolbar simulation time display", () => {
  it("does not show the old static 'Starting simulation' label while busy", () => {
    useIpcStore.setState({ status: "busy", simProgress: 0, simMessage: "Starting simulation…" });
    render(<MainToolbar onAction={() => {}} />);

    expect(screen.queryByText("Starting simulation…")).toBeNull();
  });

  it("shows no progress meter while busy", () => {
    // #189: the meter was fed by the kernel's heartbeat, and since #159 a run
    // goes to the extension host where the solver writes its container
    // directly -- nothing reports a fraction. It sat at 0% for the whole run,
    // which reads as a hung solver. No meter is the better answer.
    useIpcStore.setState({ status: "busy", runStartedAt: Date.now() });
    render(<MainToolbar onAction={() => {}} />);

    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("shows elapsed wall-clock time, not a simulated time it cannot know", () => {
    useSimSettingsStore.setState((state) => ({ settings: { ...state.settings, tEnd: 0.01 } }));
    useIpcStore.setState({ status: "busy", runStartedAt: Date.now() - 2_400 });
    render(<MainToolbar onAction={() => {}} />);

    expect(screen.getByText("2.4 s")).toBeTruthy();
    // And specifically not the old "current / final simulated time" readout,
    // whose current half was always 0.
    expect(screen.queryByText(/\/ 10ms$/)).toBeNull();
  });

  it("keeps the elapsed time moving", async () => {
    vi.useFakeTimers();
    try {
      useIpcStore.setState({ status: "busy", runStartedAt: Date.now() });
      render(<MainToolbar onAction={() => {}} />);
      expect(screen.getByText("0.0 s")).toBeTruthy();

      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(screen.getByText("1.0 s")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a started run as busy even before the status says so", () => {
    // `runStartedAt` is the busy marker a run sets on its way out of
    // `triggerRun`, before any reply has changed `status`.
    useIpcStore.setState({ status: "idle", runStartedAt: Date.now() });
    render(<MainToolbar onAction={() => {}} />);

    // `Btn` names itself from its label, so a run in flight reads as "Stop".
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
  });

  it("shows no elapsed time when no run is in flight", () => {
    useIpcStore.setState({ status: "idle", runStartedAt: null });
    render(<MainToolbar onAction={() => {}} />);

    expect(screen.queryByText(/^\d+\.\d s$/)).toBeNull();
  });
});

describe("formatElapsed", () => {
  it("shows tenths under ten seconds, where a tenth is noticeable", () => {
    expect(formatElapsed(0)).toBe("0.0 s");
    expect(formatElapsed(430)).toBe("0.4 s");
    expect(formatElapsed(9_940)).toBe("9.9 s");
  });

  it("shows whole seconds up to a minute", () => {
    expect(formatElapsed(10_000)).toBe("10 s");
    expect(formatElapsed(59_900)).toBe("59 s");
  });

  it("shows m:ss beyond a minute, which is how a long wait reads", () => {
    expect(formatElapsed(60_000)).toBe("1:00");
    expect(formatElapsed(65_400)).toBe("1:05");
    expect(formatElapsed(3_605_000)).toBe("60:05");
  });

  it("never shows a negative time, whatever the clock did", () => {
    // A clock adjustment mid-run must not print "-3.0 s".
    expect(formatElapsed(-3_000)).toBe("0.0 s");
  });
});
