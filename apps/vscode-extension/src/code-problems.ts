/**
 * The one `DiagnosticCollection` this extension owns, and the editor API around it (#237).
 *
 * The thin half. `code-block-failure.ts` parses what the solver and the compiler said, and
 * `code-diagnostics.ts` decides where each failure goes; this is the part that imports `vscode`,
 * so those two can be tested without an editor and this one is almost nothing but wiring.
 *
 * Created in `activate()` and disposed with the extension, which is the whole of its lifetime.
 * Two things it does on its own:
 *
 * - **Clears a file's diagnostics when the file is edited.** The moment the source changes the
 *   line numbers are stale, and a diagnostic on the wrong line is a false accusation. One
 *   `onDidChangeTextDocument` subscription, owned here so no caller has to remember.
 * - **Never steals focus.** No `showTextDocument`, no `revealRange`. The Problems entry and the
 *   output channel are enough; the canvas stays where the user left it.
 */
import * as path from "node:path";

import * as vscode from "vscode";

import { readCompilerDiagnostics, readSolverFailures } from "./code-block-failure";
import { DIAGNOSTIC_SOURCE, type Failure, forgetFile, publishFailures } from "./code-diagnostics";

export const DIAGNOSTIC_COLLECTION_NAME = DIAGNOSTIC_SOURCE;

/** What a run tells the collection about itself. */
export interface RunContext {
  /** The directory the solver was spawned in, which is what a relative path is relative to. */
  workingDirectory: string;
  /** The `.gsim_sch`, for failures with no file of their own. `undefined` for an unsaved sheet. */
  schematic?: vscode.Uri;
}

export class CodeProblems implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    languages: Pick<typeof vscode.languages, "createDiagnosticCollection"> = vscode.languages,
    workspace: Pick<typeof vscode.workspace, "onDidChangeTextDocument"> = vscode.workspace,
  ) {
    this.collection = languages.createDiagnosticCollection(DIAGNOSTIC_COLLECTION_NAME);
    this.disposables.push(this.collection);
    // Editing a file invalidates everything said about it: the line numbers have moved and a
    // squiggle on the wrong line accuses innocent code. Cheaper and more honest than trying to
    // shift them.
    this.disposables.push(
      workspace.onDidChangeTextDocument((event) => {
        if (event.contentChanges.length > 0) {
          forgetFile(this.asCollection(), event.document.uri);
        }
      }),
    );
  }

  /**
   * Start a run with an empty panel.
   *
   * Called before anything else a run does. A red squiggle surviving a fix is the standard
   * failure of a feature like this, and it is worse than no squiggle at all: the user fixes the
   * code, runs, sees the same error and concludes the fix did not work.
   */
  beginRun(): void {
    this.collection.clear();
  }

  /**
   * Publish whatever this run's output says went wrong, replacing the last run's.
   *
   * Both sources at once: a compiler's diagnostic and the solver's own error are different
   * failures with the same destination, and the user does not care which produced the squiggle.
   */
  report(context: RunContext, lines: readonly string[]): number {
    const failures: Failure[] = [...readCompilerDiagnostics(lines), ...readSolverFailures(lines)];
    const published = publishFailures(
      this.asCollection(),
      {
        // Relative to the directory the solver ran in, which is the schematic's own folder
        // (#234) -- the same base the netlist's own relative paths resolve against.
        resolve: (file) =>
          vscode.Uri.file(
            path.isAbsolute(file) ? file : path.resolve(context.workingDirectory, file),
          ),
        schematic: context.schematic,
        key: (uri) => uri.toString(),
      },
      failures,
    );
    let count = 0;
    for (const diagnostics of published.values()) {
      count += diagnostics.length;
    }
    return count;
  }

  /** The adapter `code-diagnostics.ts` works against, so that module imports no `vscode`. */
  private asCollection() {
    return {
      set: (
        uri: vscode.Uri,
        diagnostics: {
          message: string;
          line: number;
          character: number;
          severity: "error" | "warning";
          source: string;
        }[],
      ) => {
        this.collection.set(
          uri,
          diagnostics.map((diagnostic) => {
            const position = new vscode.Position(diagnostic.line, diagnostic.character);
            const entry = new vscode.Diagnostic(
              new vscode.Range(position, position),
              diagnostic.message,
              diagnostic.severity === "warning"
                ? vscode.DiagnosticSeverity.Warning
                : vscode.DiagnosticSeverity.Error,
            );
            entry.source = diagnostic.source;
            return entry;
          }),
        );
      },
      delete: (uri: vscode.Uri) => this.collection.delete(uri),
      clear: () => this.collection.clear(),
      dispose: () => this.collection.dispose(),
    };
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}
