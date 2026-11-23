/**
 * #139: a run's output reaches VS Code's Output panel, labelled by source.
 *
 * Note what cannot be tested here, by design of the VS Code API: there is **no
 * way to read an output channel's contents**, and no way to observe the colour
 * a level is rendered in. So the unit under test is the mapping from a labelled
 * line to a channel call, verified against a recording channel; that the
 * message reaches the host at all is the integration suite's job, and the
 * colour is a visual check.
 */
import { describe, expect, it } from "vitest";

import { createRecordingLogChannel } from "./test-support/vscode-stub";

import { writeRunOutput } from "./run-output";

describe("#139: run output goes to the channel with its source and severity", () => {
  it("prefixes each line with its source, so a build error is not read as a solver error", () => {
    const channel = createRecordingLogChannel();

    writeRunOutput(channel, [
      { source: "compile", severity: "info", text: "compiled 10 netlist lines" },
      { source: "build", severity: "error", text: "cscript.c:12:5: error: 'x' undeclared" },
      { source: "solver", severity: "error", text: "singular matrix at t=0" },
    ]);

    expect(channel.entries).toEqual([
      { level: "info", text: "[compile] compiled 10 netlist lines" },
      { level: "error", text: "[build] cscript.c:12:5: error: 'x' undeclared" },
      { level: "error", text: "[solver] singular matrix at t=0" },
    ]);
  });

  it("maps each severity onto the channel level VS Code colours for it", () => {
    const channel = createRecordingLogChannel();

    writeRunOutput(channel, [
      { source: "solver", severity: "info", text: "a" },
      { source: "solver", severity: "warning", text: "b" },
      { source: "solver", severity: "error", text: "c" },
    ]);

    expect(channel.entries.map((entry) => entry.level)).toEqual(["info", "warn", "error"]);
  });

  it("splits a chunk that arrived as one string with embedded newlines", () => {
    // Solver output arrives in chunks, not lines: a single chunk routinely
    // holds a whole block of compiler output. Writing it unsplit puts a
    // multi-line blob on one channel entry, which loses the per-line level and
    // reads as one enormous message.
    const channel = createRecordingLogChannel();

    writeRunOutput(channel, [
      { source: "build", severity: "error", text: "line one\nline two\nline three" },
    ]);

    expect(channel.entries).toEqual([
      { level: "error", text: "[build] line one" },
      { level: "error", text: "[build] line two" },
      { level: "error", text: "[build] line three" },
    ]);
  });

  it("drops blank lines rather than filling the panel with empty timestamps", () => {
    // A LogOutputChannel stamps every entry with a time and level, so an empty
    // line is not empty on screen -- it is a dated, levelled blank.
    const channel = createRecordingLogChannel();

    writeRunOutput(channel, [{ source: "solver", severity: "info", text: "before\n\n   \nafter" }]);

    expect(channel.entries).toEqual([
      { level: "info", text: "[solver] before" },
      { level: "info", text: "[solver] after" },
    ]);
  });

  it("writes nothing at all for an empty batch, so the panel does not steal focus", () => {
    const channel = createRecordingLogChannel();
    writeRunOutput(channel, []);
    expect(channel.entries).toEqual([]);
  });
});
