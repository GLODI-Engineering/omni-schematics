/**
 * #130: a Run click that can never succeed must still answer.
 *
 * The webview learns the kernel's fate from exactly one place — `onDidChange`,
 * which `host.ts` forwards as `gsim/kernelConfig` or `gsim/kernelStopped`. The
 * webview's wait for those messages is what `triggerRun()` awaits before it
 * does anything else. So a `doStart()` path that returns without firing leaves
 * that await pending forever: no toast, no Output line, no error, and a button
 * that visibly does nothing. That was the reported symptom.
 *
 * These tests pin the contract "every exit from a start attempt fires exactly
 * one event", one test per way a start can fail.
 */
import { afterEach, describe, expect, it } from "vitest";

import { __setTestState, __shownErrors, createRecordingChannel } from "./test-support/vscode-stub";

import { KernelSidecar } from "./kernel";

function subscribe(kernel: KernelSidecar) {
  const seen: (unknown | null)[] = [];
  const sub = kernel.onDidChange((config) => seen.push(config));
  return { seen, dispose: () => sub.dispose() };
}

afterEach(() => {
  __setTestState({});
});

describe("#130: a failed kernel start tells the webview", () => {
  it("fires onDidChange(null) when there is no workspace to find a kernel in", async () => {
    // No configured root and no open folder: `resolveWorkspaceRoot` returns
    // null and `doStart` gives up at kernel.ts:117. This is the exact shape of
    // a fresh .vsix install on a machine with no checkout of this repo.
    __setTestState({ config: {}, workspaceFolders: undefined });

    const log = createRecordingChannel();
    const kernel = new KernelSidecar(log);
    const { seen, dispose } = subscribe(kernel);

    const result = await kernel.start();

    expect(result).toBeNull();
    expect(seen).toEqual([null]);

    dispose();
    kernel.dispose();
  });

  it("fires onDidChange(null) when the configured workspaceRoot holds no pyproject.toml", async () => {
    // The user set `workspaceRoot`, but to a directory that is not a checkout
    // of this repo -- e.g. to the `general-simulator` repo, which is pure Rust
    // and has no pyproject.toml. Reported in exactly this form.
    __setTestState({ config: { workspaceRoot: "/nonexistent/not-a-checkout" } });

    const log = createRecordingChannel();
    const kernel = new KernelSidecar(log);
    const { seen, dispose } = subscribe(kernel);

    const result = await kernel.start();

    expect(result).toBeNull();
    expect(seen).toEqual([null]);

    dispose();
    kernel.dispose();
  });

  it("names the cause somewhere the user will see it, not only in the Output channel", async () => {
    // The Output channel is closed by default. The kernel's diagnosis is the
    // single most useful sentence a new user can be handed, so it has to reach
    // a notification too.
    __setTestState({ config: { workspaceRoot: "/nonexistent/not-a-checkout" } });

    const log = createRecordingChannel();
    const kernel = new KernelSidecar(log);

    await kernel.start();

    expect(__shownErrors().join("\n")).toMatch(/pyproject\.toml|workspaceRoot/);

    kernel.dispose();
  });

  it("reports a reason with the stop, so the webview can say which failure it was", async () => {
    __setTestState({ config: {}, workspaceFolders: undefined });

    const log = createRecordingChannel();
    const kernel = new KernelSidecar(log);

    await kernel.start();

    expect(kernel.lastFailure).toBeTruthy();
    expect(kernel.lastFailure ?? "").toMatch(/pyproject\.toml|workspaceRoot|checkout/);

    kernel.dispose();
  });
});
