/**
 * A code block's failure, in the Problems panel, clickable (#237).
 *
 * Invariant 0 says to use VS Code's own surfaces — "`Diagnostic` for problems". Before this,
 * `grep -rn createDiagnosticCollection apps/` returned nothing: there was no
 * `DiagnosticCollection` in the extension at all, so nothing this editor produced appeared in
 * the Problems panel and nothing was ever clickable. What a user got when the code in a block
 * was wrong was the solver's stderr, mirrored into the output channel as one line — a line
 * number to scroll to by hand, in a tab this extension had opened for them, two panes away.
 *
 * ## Two sources, one collection
 *
 * A compiler's diagnostic and the solver's own error are different failures with the same
 * destination, and the user does not care which produced the squiggle. `code-block-failure.ts`
 * parses both into `(file, line, column, message)`; this attaches them.
 *
 * ## It degrades, and never drops anything
 *
 * That is the rule, because the commonest class of code-block failure has **no** file and line:
 * a missing library, a missing `output` function, an arity disagreement. Those are facts about
 * the document, so a failure with no location is attached to the **`.gsim_sch` itself**.
 * Diagnostics can be set on any URI, so "this block's library is missing" becomes a clickable
 * Problems entry that opens the sheet. A failure that cannot be placed is still shown; it is
 * never silently dropped, and nothing here invents a line in a file it did not read.
 *
 * ## Lifecycle, which is where this kind of feature usually goes wrong
 *
 * - **Cleared at the start of every run.** A red squiggle surviving a fix is the standard
 *   failure of a feature like this, and it is worse than no squiggle: the user fixes the code,
 *   runs, sees the same error and concludes the fix did not work.
 * - **A file's diagnostics are cleared when that file is edited.** The moment the source changes
 *   the line numbers are stale, and a diagnostic on the wrong line is a false accusation.
 * - **Focus is never stolen.** No `showTextDocument`, no `revealRange`. The Problems entry and
 *   the output channel are enough; the canvas stays where the user left it.
 */

export interface DiagnosticLike {
  message: string;
  /** 0-based, as VS Code's `Position` is. */
  line: number;
  character: number;
  severity: "error" | "warning";
  /** `Omni Schematics`, so a reader can tell our entries from a language server's. */
  source: string;
}

/** The slice of `vscode.DiagnosticCollection` this needs, so it can be tested. */
export interface Collection<Uri> {
  set: (uri: Uri, diagnostics: DiagnosticLike[]) => void;
  delete: (uri: Uri) => void;
  clear: () => void;
  dispose: () => void;
}

export interface Placement<Uri> {
  /** A path as a tool printed it, resolved against the directory the run was spawned in. */
  resolve: (file: string) => Uri;
  /** The schematic, for every failure that has no file of its own. */
  schematic: Uri | undefined;
  /** Compares two URIs; `Map` keys on object identity, and two `Uri`s for one path are not. */
  key: (uri: Uri) => string;
}

export interface Failure {
  message: string;
  detail?: string;
  location?: { file: string; line: number; column?: number };
  origin: "solver" | "compiler";
  block?: string;
}

export const DIAGNOSTIC_SOURCE = "Omni Schematics";

/**
 * Put these failures in the Problems panel, replacing whatever the last run put there.
 *
 * Returns what was set, keyed by URI, so a caller can assert the placement without a running
 * editor — and so the one thing worth asserting is assertable: that a failure with no location
 * went to the schematic rather than nowhere.
 */
export function publishFailures<Uri>(
  collection: Collection<Uri>,
  placement: Placement<Uri>,
  failures: readonly Failure[],
): Map<string, DiagnosticLike[]> {
  // Replacing, not adding: a diagnostic from the previous run is about code that may since
  // have been fixed, and a stale squiggle is worse than none.
  collection.clear();

  const byUri = new Map<string, { uri: Uri; diagnostics: DiagnosticLike[] }>();
  for (const failure of failures) {
    const uri =
      failure.location === undefined
        ? placement.schematic
        : placement.resolve(failure.location.file);
    if (uri === undefined) {
      // No location *and* no schematic: an unsaved sheet, or an imported netlist. There is
      // nowhere to attach it, and the output channel has it either way.
      continue;
    }
    const key = placement.key(uri);
    const entry = byUri.get(key) ?? { uri, diagnostics: [] };
    entry.diagnostics.push({
      // Both halves: a Problems entry shows the first line and the rest on hover, and the
      // exception a Python block raised is in the second half.
      message:
        failure.detail === undefined ? failure.message : `${failure.message}\n${failure.detail}`,
      // VS Code counts from 0 and every tool here counts from 1. A tool that reported line 0
      // would otherwise wrap to the last line of the file.
      line: Math.max(0, failure.location === undefined ? 0 : failure.location.line - 1),
      character: Math.max(0, (failure.location?.column ?? 1) - 1),
      severity: failure.message.startsWith("warning") ? "warning" : "error",
      source: DIAGNOSTIC_SOURCE,
    });
    byUri.set(key, entry);
  }

  const published = new Map<string, DiagnosticLike[]>();
  for (const [key, entry] of byUri) {
    collection.set(entry.uri, entry.diagnostics);
    published.set(key, entry.diagnostics);
  }
  return published;
}

/**
 * Forget what was said about this file.
 *
 * Called when the file is edited: the moment the source changes the line numbers are stale, and
 * a diagnostic on the wrong line is a false accusation. Cheaper and more honest than trying to
 * move them.
 */
export function forgetFile<Uri>(collection: Collection<Uri>, uri: Uri): void {
  collection.delete(uri);
}
