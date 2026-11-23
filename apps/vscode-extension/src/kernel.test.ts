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
  it("fires onDidChange(null) when no environment has been named", async () => {
    // A fresh .vsix install: nothing configured, nothing open. This is the
    // commonest state the extension is ever in, and before #130 it was the one
    // that returned without firing -- so the Run click waited forever.
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

  it("fires onDidChange(null) when the named environment is not there", async () => {
    __setTestState({ config: { kernelPython: "/nonexistent/not-an-env" } });

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
    __setTestState({ config: { kernelPython: "/nonexistent/not-an-env" } });

    const log = createRecordingChannel();
    const kernel = new KernelSidecar(log);

    await kernel.start();

    expect(__shownErrors().join("\n")).toMatch(/kernelPython/);

    kernel.dispose();
  });

  it("reports a reason with the stop, so the webview can say which failure it was", async () => {
    __setTestState({ config: {}, workspaceFolders: undefined });

    const log = createRecordingChannel();
    const kernel = new KernelSidecar(log);

    await kernel.start();

    expect(kernel.lastFailure).toBeTruthy();
    expect(kernel.lastFailure ?? "").toMatch(/kernelPython/);

    kernel.dispose();
  });
});

describe("#141: there is no fallback to a checkout", () => {
  // The point of the issue, as one assertion: with nothing configured, the
  // extension must say what to set -- not go looking for a `pyproject.toml`
  // and then complain about a checkout the user was never told to make.
  //
  // Both halves matter. Dropping the first would pass for an extension that
  // says nothing at all; dropping the second would pass for the arrangement
  // this change exists to delete.
  it("asks for kernelPython instead of hunting for a pyproject.toml", async () => {
    __setTestState({ config: {}, workspaceFolders: undefined });

    const log = createRecordingChannel();
    const kernel = new KernelSidecar(log);

    await kernel.start();

    const reason = kernel.lastFailure ?? "";
    expect(reason).toContain("omniSchematics.kernelPython");
    expect(reason).not.toMatch(/pyproject\.toml|workspaceRoot|checkout of/);

    kernel.dispose();
  });

  it("does not consult a folder that is a checkout of this repo either", async () => {
    // The strongest form of the test: the open folder *is* an omni-schematics
    // checkout, so the deleted discovery walk would have found it and launched
    // `uv`. Nothing may be read from it.
    __setTestState({ config: {}, workspaceFolders: [{ uri: { fsPath: process.cwd() } }] });

    const log = createRecordingChannel();
    const kernel = new KernelSidecar(log);

    await kernel.start();

    expect(kernel.lastFailure ?? "").toContain("omniSchematics.kernelPython");
    expect(log.lines.join("\n")).not.toContain("spawning");

    kernel.dispose();
  });

  it("tells the user how to build an environment, not only that one is missing", async () => {
    // "Set this setting" is useless advice to someone who does not have a venv
    // to point it at. The message carries the command that makes one.
    __setTestState({ config: {}, workspaceFolders: undefined });

    const log = createRecordingChannel();
    const kernel = new KernelSidecar(log);

    await kernel.start();

    expect(kernel.lastFailure ?? "").toContain("make-kernel-venv");

    kernel.dispose();
  });
});

describe("#134: the named environment is what gets started", () => {
  it("fails naming kernelPython, without falling through to the workspace search", async () => {
    // The failure has to name the path that was tried. "No interpreter found"
    // on its own leaves the user guessing whether the setting was even read --
    // and a typo in a long path is the likeliest cause by far.
    __setTestState({ config: { kernelPython: "/envs/does-not-exist" } });

    const log = createRecordingChannel();
    const kernel = new KernelSidecar(log);
    const { seen, dispose } = subscribe(kernel);

    const result = await kernel.start();

    expect(result).toBeNull();
    expect(seen).toEqual([null]);
    expect(kernel.lastFailure ?? "").toContain("kernelPython");
    expect(kernel.lastFailure ?? "").toContain("/envs/does-not-exist");

    dispose();
    kernel.dispose();
  });

  it("does not require a workspace folder at all when kernelPython is set", async () => {
    // No folder open: under the old arrangement this could not even be
    // attempted. The attempt failing on a bogus path is fine; what matters is
    // that it is the path that failed, not the absence of a workspace.
    __setTestState({
      config: { kernelPython: "/envs/does-not-exist" },
      workspaceFolders: undefined,
    });

    const log = createRecordingChannel();
    const kernel = new KernelSidecar(log);

    await kernel.start();

    expect(kernel.lastFailure ?? "").toMatch(/kernelPython/);
    kernel.dispose();
  });
});
