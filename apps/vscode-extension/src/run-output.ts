/**
 * A run's output, in VS Code's Output panel (#139).
 *
 * The webview opens its own socket to the kernel sidecar, so the extension host
 * sees nothing of a run unless the webview forwards it. Before this, output went
 * only to the webview's own bottom-panel Output tab -- which is not the panel
 * beside the terminal, and is not even mounted in every shell.
 *
 * A `LogOutputChannel` is used rather than a plain one because VS Code colours
 * its levels itself: no TextMate grammar, no theme guessing. What a level cannot
 * express is *where a line came from*, and a compiler diagnostic and a solver
 * complaint read identically as bare text while meaning entirely different
 * things to whoever has to fix them -- so the source is carried in the line.
 */
import type { RunOutputLine, RunOutputSeverity } from "@gensim/webview-protocol";
import type * as vscode from "vscode";

/** The subset of `vscode.LogOutputChannel` this needs, so it can be tested. */
export interface LevelledChannel {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const RUN_OUTPUT_CHANNEL_NAME = "Omni Schematics";

/** Create the channel runs are written to. */
export function createRunOutputChannel(
  window: Pick<typeof vscode.window, "createOutputChannel">,
): vscode.LogOutputChannel {
  // `{ log: true }` is what makes it a LogOutputChannel: levels, timestamps and
  // the level filter in the panel's own gear menu come with it.
  return window.createOutputChannel(RUN_OUTPUT_CHANNEL_NAME, { log: true });
}

function write(channel: LevelledChannel, severity: RunOutputSeverity, text: string): void {
  if (severity === "error") {
    channel.error(text);
  } else if (severity === "warning") {
    channel.warn(text);
  } else {
    channel.info(text);
  }
}

/**
 * Write a batch of labelled lines to the channel.
 *
 * Chunks, not lines, are what the solver sends: one chunk routinely carries a
 * whole block of compiler output. Each is split, because an unsplit blob lands
 * as a single entry with one timestamp and one level, which reads as one
 * enormous message and loses the per-line severity. Blank lines are dropped --
 * a LogOutputChannel stamps every entry with a time and a level, so an empty
 * line is not empty on screen but a dated, levelled blank.
 */
export function writeRunOutput(channel: LevelledChannel, lines: readonly RunOutputLine[]): void {
  for (const line of lines) {
    for (const part of line.text.split(/\r?\n/)) {
      if (part.trim().length === 0) {
        continue;
      }
      write(channel, line.severity, `[${line.source}] ${part}`);
    }
  }
}

/**
 * A channel that records what it was given, for the integration suite.
 *
 * Lives beside the real one rather than in test code because `extension.ts`
 * constructs it: VS Code has no API to read an output channel back, so proving
 * the webview -> host -> panel path works at all needs the host to be holding
 * something inspectable while a real webview drives it.
 */
export function createRecordingRunOutput(): LevelledChannel & {
  readonly entries: { level: string; text: string }[];
} {
  const entries: { level: string; text: string }[] = [];
  return {
    entries,
    info: (text: string) => entries.push({ level: "info", text }),
    warn: (text: string) => entries.push({ level: "warn", text }),
    error: (text: string) => entries.push({ level: "error", text }),
  };
}
