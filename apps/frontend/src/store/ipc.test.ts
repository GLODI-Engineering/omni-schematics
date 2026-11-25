/**
 * FE-04: IPC store — the state a run leaves behind.
 *
 * Two groups of tests are gone with the thing that drove them. `status` was
 * the kernel connection's — disconnected/connecting/idle/busy/error, set from
 * a `kernel_status` frame — and `registerLiveSignal` built a provisional
 * manifest as binary chunk frames arrived. #157 ended the chunks and #162
 * deleted the kernel, so a run in flight is `runStartedAt` and the manifest
 * arrives once, whole.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useIpcStore } from "./ipc";

beforeEach(() => {
  useIpcStore.setState({
    pendingIds: new Map(),
    lastManifest: null,
    waveformSlice: null,
    output: [],
    problems: [],
    runStartedAt: null,
  });
});

describe("FE-04: IPC store", () => {
  it("pendingIds is a Map", () => {
    expect(useIpcStore.getState().pendingIds).toBeInstanceOf(Map);
  });

  it("addPendingId / removePendingId round-trip", () => {
    useIpcStore.getState().setPending("req1", { action: "simulate", startedAt: Date.now() });
    expect(useIpcStore.getState().pendingIds.has("req1")).toBe(true);
    useIpcStore.getState().clearPending("req1");
    expect(useIpcStore.getState().pendingIds.has("req1")).toBe(false);
  });

  it("setLastManifest is the one way a run's signals arrive", () => {
    useIpcStore.getState().setLastManifest({
      sim_id: "sim-1",
      signals: ["v(out)", "i(v1)"],
      t_start: 0,
      t_end: 0.01,
    });
    expect(useIpcStore.getState().lastManifest?.signals).toEqual(["v(out)", "i(v1)"]);
    expect(useIpcStore.getState().lastManifest?.t_end).toBe(0.01);
  });

  it("resetForNewModel clears the run in flight, so the toolbar cannot stay on Stop", () => {
    useIpcStore.setState({ runStartedAt: Date.now() });
    useIpcStore.getState().resetForNewModel();
    expect(useIpcStore.getState().runStartedAt).toBeNull();
  });
});
