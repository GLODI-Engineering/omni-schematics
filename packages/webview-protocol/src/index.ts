/**
 * Message protocol between the General Simulator webviews and the VS Code
 * extension host.
 *
 * **One declaration.** This used to exist twice — here and in
 * `apps/vscode-extension/src/protocol.ts` — because the two apps build
 * separately (a Vite bundle against plain `tsc` for the Node extension host)
 * and a relative import across that boundary is rejected by the extension's
 * `rootDir`, even for a type. Resolving it as a workspace package through
 * `node_modules` is not, so both sides now import this file and the wire format
 * has a single source.
 *
 * Adding a message means editing one union. Nothing has to be kept in sync.
 */

/** Which surface a webview is hosting. */
export type WebviewRole = "schematic" | "library" | "waveform" | "results";

/** Injected into every webview as `window.__GSIM_INIT__` before the bundle runs. */
export interface WebviewInit {
  role: WebviewRole;
  /** Present for the schematic custom editor: the `.gsim_sch` file's URI string. */
  documentUri?: string;
  /** Present for the schematic custom editor: the on-disk document contents. */
  documentText?: string;
  /** User-authored components read from the workspace before React mounts. */
  userSymbols?: unknown[];
  /**
   * Set only by the @vscode/test-electron integration harness. Installs the
   * `gsim/test/exec` handler so the extension host can drive this webview's
   * real DOM and stores from an integration test.
   */
  testMode?: boolean;
}

// ---------------------------------------------------------------------------
// webview -> extension host
// ---------------------------------------------------------------------------

export type HostBoundMessage =
  /** The webview finished mounting and is ready to receive host messages. */
  | { type: "gsim/ready"; role: WebviewRole }
  /**
   * The in-app File actions, handed off to VS Code when the app runs inside a
   * Custom Editor. VS Code — not this app's storage adapter — owns the
   * document lifecycle there, so New/Open/Save/Close become requests for the
   * workbench's own commands. See `file/host-file-actions.ts`.
   */
  | { type: "gsim/newSchematic" }
  | { type: "gsim/openSchematic" }
  | { type: "gsim/saveDocument"; as?: boolean }
  | { type: "gsim/closeDocument" }
  /** The schematic document was edited in the webview; marks the editor dirty. */
  | { type: "gsim/documentChanged"; text: string; label: string }
  /** Reply to a `gsim/requestDocument`. */
  | { type: "gsim/documentContent"; requestId: string; text: string }
  /** A library-item drag began; the host brokers the payload to other webviews. */
  | { type: "gsim/dragStart"; blockName: string; label: string }
  /** The library-item drag ended (dropped or cancelled). */
  | { type: "gsim/dragEnd" }
  /** Click-to-insert from the library sidebar into the active schematic editor. */
  | { type: "gsim/insertBlock"; blockName: string }
  /** A simulation finished; carries the sim id the waveform panel should attach to. */
  | { type: "gsim/simulationFinished"; simId: string }
  /**
   * Run this netlist (#159). The webview compiled it; the host runs the solver.
   *
   * The netlist travels **one way, already compiled, as a string**. Nothing is
   * passed back into the webview to ask what a block means: the engine runs
   * where it is already loaded (`engine/engine.ts`), and the host does what a
   * webview cannot — resolve a binary, spawn it, read and write files, own an
   * Output channel. That division is the decision recorded on #175, and the
   * packaging reason behind it is in `apps/vscode-extension/src/protocol.ts`.
   */
  | { type: "gsim/runSimulation"; requestId: string; request: RunRequest }
  /**
   * Stop the run with this `requestId`.
   *
   * The Stop button used to close a socket to a Python sidecar, which left the
   * solver running as that process's own child. The host holds the child
   * process now, so stopping means signalling it — and `SIGTERM` rather than
   * `SIGKILL`,
   * because the container's footer is written last and a politely killed run
   * leaves a file the reader reports as truncated rather than as rubbish.
   */
  | { type: "gsim/cancelRun"; requestId: string }
  /**
   * Lines a run produced, for the VS Code Output panel (#139).
   *
   * What the webview itself reports — a document that will not compile, an
   * empty sheet — is known only to the webview, so the host sees nothing of it
   * unless it is told. Output used to go only to the webview's own
   * bottom-panel Output tab, which is not the VS Code Output panel and is not
   * mounted in every shell. The solver's own two streams reach the channel
   * directly, because the host is what spawns it.
   */
  | { type: "gsim/output"; lines: RunOutputLine[] }
  /**
   * Persist an authored component to `.gsim/symbols/<name>.gsim_sym` in the
   * workspace. Without this the symbol editor's output lived only in the
   * running catalog and was lost on reload.
   */
  | { type: "gsim/saveSymbol"; name: string; metadata: unknown }
  /**
   * Read a scripted block's source, so the editor can show what ports it
   * looks like it expects. The host confines the path to the workspace.
   *
   * `relativeTo` is the schematic the path was written in — a block parameter
   * is relative to the sheet, not to the workspace root, and the two are only
   * the same directory by accident. Absent, or not found there, the host falls
   * back to the workspace root, which is where this resolved before #212.
   */
  | { type: "gsim/readSource"; requestId: string; path: string; relativeTo?: string }
  /**
   * Open a scripted block's source in a VS Code text editor (#212).
   *
   * The reason the editor is in VS Code at all: a `pyfunc` is a Python file,
   * and the user wants Python tooling on it rather than a text box of our own.
   * So this asks for nothing clever — `openTextDocument` plus
   * `showTextDocument`, and the language extensions attach by file extension.
   *
   * `candidates` is a list because a `cscript` block's parameter is `lib`, a
   * compiled `.so`, and the source beside it is a convention rather than a
   * fact (see `apps/frontend/src/netlist/code-source.ts`). The host opens the
   * first that exists. `create` is the one it offers to write, with `stub` as
   * the contents — composed in the webview, which is where the knowledge of
   * what each language's entry point must look like already lives
   * (`netlist/code-ports.ts`).
   *
   * **The host decides whether the path is acceptable, not the webview.** A
   * `.gsim_sch` may have been opened from anywhere and its parameters are
   * untrusted strings; a document must not be able to make the extension open
   * or create an arbitrary file. The host confines both to the workspace, and
   * asks before opening anything outside it.
   */
  | {
      type: "gsim/openBlockSource";
      requestId: string;
      /** Only for the host's log, so a refusal names the block. */
      blockId: string;
      /** Relative to `relativeTo`, or absolute. Best first. */
      candidates: string[];
      /** Which of `candidates` to offer to create. */
      create: string;
      /** What to write when creating it. */
      stub: string;
      /** URI of the schematic the paths are relative to. */
      relativeTo?: string;
    }
  /**
   * Byte ranges of a `.gsim_samples` container (#157).
   *
   * The division this message exists for: a webview can run WebAssembly but
   * cannot read a file, and the extension host can read a file but cannot
   * load the WebAssembly — `vsce package --no-dependencies` ships no
   * `node_modules`, so a value import of a workspace package from the host
   * throws `Cannot find module` on every machine but a developer's (#175).
   *
   * So the webview plans and the host fetches. `crates/waveform-store`
   * computes which ranges a window needs from the stripe directory alone —
   * index arithmetic, with no sample value taking part — and they arrive here
   * as a list. An empty `ranges` asks only for the file's size, which is the
   * first thing a reader needs and the one number it cannot derive.
   */
  | { type: "gsim/readSamples"; requestId: string; request: SamplesReadRequest }
  /** Open the waveform panel. */
  | { type: "gsim/showWaveforms" }
  | { type: "gsim/log"; level: "info" | "warn" | "error"; message: string }
  /**
   * The webview was handed a document it could not read.
   *
   * Distinct from `gsim/log` because the two have different audiences. `gsim/log`
   * is appended to the extension's own lifecycle channel, which is closed by
   * default and right for diagnostics nobody needs unless they go looking. A file the user
   * just opened and which did not load is not that: it is the one thing they are
   * waiting to be told. Routed through `gsim/log` alone, the editor showed an
   * empty canvas and a toast saying the schematic was empty -- true of the store,
   * and the opposite of helpful (#146).
   */
  | { type: "gsim/documentUnreadable"; reason: string }
  /** Integration-harness only: reply to a `gsim/test/exec`. */
  | { type: "gsim/test/report"; requestId: string; ok: boolean; result: unknown };

/**
 * Where a line of run output came from.
 *
 * Carried so the Output panel can distinguish a compiler diagnostic from a
 * solver complaint -- they read identically as bare text and mean entirely
 * different things to whoever has to fix them.
 *
 * - `solver`  the simulation engine's own messages
 * - `build`   compiling a `cscript` / `pyblock` / `octfunc` code block
 * - `compile` turning the schematic into a netlist
 * - `editor`  the front end's own reporting, e.g. "the schematic is empty"
 *
 * `kernel` was a fifth, for the Python sidecar's own lifecycle. Nothing can
 * produce one (#162).
 */
export type RunOutputSource = "solver" | "build" | "compile" | "editor";

/** Severity, mapped onto the output channel's own levels. */
export type RunOutputSeverity = "info" | "warning" | "error";

export interface RunOutputLine {
  source: RunOutputSource;
  severity: RunOutputSeverity;
  text: string;
}

/** What became of a `gsim/openBlockSource`. */
export type OpenBlockSourceResult =
  | {
      ok: true;
      /** The path that was opened, as the host resolved it. */
      path: string;
      /** True when the file did not exist and the user agreed to create it. */
      created: boolean;
    }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Running a simulation in the extension host (#159)
// ---------------------------------------------------------------------------

/**
 * What the host needs to run one analysis, and nothing more.
 *
 * `transient` is the only member because `--mode dc|transient` is the whole of
 * the solver's analysis surface and `solver-run.ts` builds a transient command
 * line. An AC sweep, a DC sweep and an operating point have no route through
 * this binary, so the editor refuses them in the webview with that as the
 * reason rather than sending something the host would have to guess at.
 */
/**
 * One code block on the sheet, and where its source is, so the host can tell whether the
 * artifact it is about to run was built from it (#235).
 *
 * The netlist cannot answer this. A `cscript` block's parameter is `lib` — a compiled library —
 * and the source is not named in the document at all, so only the webview, which holds the
 * block and this editor's convention for finding its `.c`, can say where to look. (That the
 * convention is a convention rather than a fact the document states is
 * `GLODI-Engineering/omni-schematics#222`; `inferredSource` carries that distinction through so
 * the host's message can be honest about it.)
 *
 * Paths are **relative to the schematic**, like every path a block carries, and the host
 * resolves them against the schematic's own folder — the same directory it spawns the solver in
 * (#234).
 *
 * ## This field is provisional, and `sourceCandidates` is a guess
 *
 * Say it here rather than leave it to be discovered: **`sourceCandidates` is a list the webview
 * derives by convention** (`blocks/<stem>.c`, then beside the library, then the sheet's folder,
 * then `src/`, each with a `.cpp` alternative), and a convention that travels in a protocol
 * message looks exactly like a fact to whoever reads it next. It is not a fact. A project with
 * its sources in `code/` and its artifacts in `code/runs/<case>/` matches none of those folders,
 * and this field will say so by listing candidates none of which exist.
 *
 * It shipped ahead of the tidier design on purpose: the staleness refusal removes a silent wrong
 * result today, and `GLODI-Engineering/omni-schematics#222` — the `source` parameter that would
 * make the link something the **document states** — is a cross-repo change needing a component
 * library entry in the engine and a release behind it. Blocking a wrong-answer fix on that is
 * the wrong trade.
 *
 * So: **expect this field to be replaced** by a document-stated source once #222 lands, and do
 * not build anything on it that needs `sourceCandidates` to be true rather than plausible.
 * `inferredSource` is what carries the distinction to a consumer, and the one feature built on
 * this field so far — the staleness check — says "could not find the source, and the list I
 * looked in is this editor's convention rather than something the document states" instead of
 * implying it checked.
 */
export interface RunCodeBlock {
  /** The block's id on the sheet, which is also the name the netlist gives it. */
  blockId: string;
  /** Which of the three languages, as `code-source.ts` decides it from the block type. */
  language: "c" | "python" | "octave";
  /**
   * A `cscript` block's `lib=`, as written. Absent for the other four, whose `path=` already
   * names the file the user edits, so there is no artifact to go stale against it.
   */
  artifact?: string;
  /** Where the source might be, best first. The first that exists is the one meant. */
  sourceCandidates: string[];
  /**
   * Whether `sourceCandidates` is this editor's convention rather than something the document
   * states. True for `cscript` today, and the reason a host message has to say "could not find
   * a source" rather than "the source is up to date".
   */
  inferredSource: boolean;
}

export interface RunRequest {
  /**
   * Which of the engine's two analyses to run.
   *
   * `general-simulator --mode` takes exactly these two: `transient` runs the
   * timestep loop, `dc` solves a single operating point and emits one row.
   * They are not variations on one command line -- `--tfinal` and `--dt` mean
   * nothing to `dc` -- which is why this is a discriminator and not a flag.
   */
  mode: "transient" | "dc";
  /** The netlist, as the engine compiled it. The host writes it to a file verbatim. */
  netlist: string;
  /** The transient window. Absent for `dc`, which has no window. */
  tEnd?: number;
  /** The transient step. Absent for `dc`, which takes a single solve. */
  tStep?: number;
  /**
   * URI of the `.gsim_sch` this came from, when it came from one.
   *
   * A URI rather than a path because that is what the webview has
   * (`WebviewInit.documentUri`), and the host turns it into the
   * workspace-relative path the result schema asks for. A webview cannot: it
   * does not know where the workspace root is.
   */
  source?: string;
  /**
   * Analysis name recorded in the result document -- `TRAN` or `OP` -- and what
   * a reader shows. Distinct from `mode`: `mode` is the engine's command line,
   * this is the document's vocabulary, and the two need not stay in step if the
   * engine ever grows an analysis the format already names.
   */
  analysis: string;
  /**
   * The sheet's code blocks and where their sources are, so the host can refuse a run whose
   * compiled library is older than the `.c` it came from (#235).
   *
   * Optional, and absent for an imported netlist: a `.cir` opened from disk has no document
   * behind it, so there are no blocks to ask about. A host that gets no list checks nothing,
   * which is the behaviour before this field existed.
   */
  codeBlocks?: RunCodeBlock[];
}

/** Why a run did not produce a result. Each needs a different thing of the user. */
export type RunFailureKind =
  /** No `general-simulator` binary anywhere the host looked. */
  | "solver-not-found"
  /** A binary was found and the spawn itself failed. */
  | "could-not-start"
  /** It ran and exited non-zero, or was killed. */
  | "failed"
  /** It was still running when the host's limit expired. */
  | "timed-out"
  /** It exited 0 and wrote no readable container, which is a bug in it or in us. */
  | "no-result";

/**
 * One rule event, as the webview needs it for the Problems panel.
 *
 * A narrowing of `event-log.ts`'s `RuleEvent`: the fields a list entry shows,
 * with the solver-step fields left behind until something seeks to them.
 */
export interface RunEventSummary {
  rule: string;
  target: string;
  severity: string;
  /** Interpolated crossing time, in seconds. */
  time: number;
  value: number;
  limit: number;
  unit: string;
  detail: string;
}

export type RunResult =
  | {
      ok: true;
      /** Absolute path of the `.gsim_sim_result` document the host wrote. */
      resultPath: string;
      /** Absolute path of the `.gsim_samples` container it points at. */
      samplesPath: string;
      /** Bytes that container occupies, so a reply can be reported without a second read. */
      samplesBytes: number;
      /** Samples per signal, read from the container's own footer. */
      rows: number;
      /** Signal names the container holds, in its order. */
      signals: string[];
      /**
       * Highest severity any rule event reached, or null when the run reported
       * none. This, not the exit status, is what decides whether the user is
       * told "finished" or "finished with errors": a run can exit 0 having
       * found a rating exceeded.
       */
      worstSeverity: "info" | "warning" | "error" | "fatal" | null;
      /** Every event the log held, capped; `eventsTotal` is the real count. */
      events: RunEventSummary[];
      eventsTotal: number;
    }
  | {
      ok: false;
      kind: RunFailureKind;
      /** One line, for a toast. */
      summary: string;
      /**
       * The rest, for the Problems panel and the Output channel. A
       * `solver-not-found` carries everywhere the host looked and how to build
       * a binary, which is always the user's next question and must not be
       * flattened away.
       */
      detail?: string;
    };

// ---------------------------------------------------------------------------
// Reading a sample container the webview cannot open (#157)
// ---------------------------------------------------------------------------

/** One byte range, as `crates/waveform-store` planned it. */
export interface SamplesRange {
  /** File offset. A `number` carries any integer below 2^53, nine petabytes. */
  offset: number;
  length: number;
}

/**
 * Which bytes of which container, and how the host is to find it.
 *
 * `path` is either absolute — what `RunResult.samplesPath` carries, from a run
 * this host itself performed — or relative, in which case it is resolved
 * against the directory of `relativeTo`. The second form is what a
 * `.gsim_sim_result` holds: its `data.path` is relative to the document, and
 * resolving it is the host's job because only the host knows where that
 * document is on disk. Either way the host decides what the path means and
 * refuses one that leaves the directory it was anchored to; the webview is
 * handed documents from anywhere and is not the right place to adjudicate
 * that.
 */
export interface SamplesReadRequest {
  path: string;
  /** URI of the document `path` is relative to, when it is relative. */
  relativeTo?: string;
  /** Empty asks only for the size. */
  ranges: SamplesRange[];
}

/**
 * The bytes, base64 of each range, in the order they were asked for.
 *
 * Base64 rather than a `Uint8Array`: a webview's `postMessage` is specified in
 * terms of JSON-serialisable values, and a typed array survives the trip as an
 * object with numeric keys on some hosts and as an array on others. A window
 * at a plot's point budget is tens of kilobytes whatever the file's length —
 * that is the property the container exists for — so the third of a byte that
 * base64 adds buys a format that cannot be misread.
 */
export type SamplesReadResult =
  | { ok: true; size: number; chunks: { offset: number; base64: string }[] }
  | { ok: false; summary: string };

// ---------------------------------------------------------------------------
// extension host -> webview
// ---------------------------------------------------------------------------

export type WebviewBoundMessage =
  /** Replace the schematic document (initial load, revert, external file change). */
  | { type: "gsim/setDocument"; text: string }
  /** Host asks the webview to serialise its current document (save / backup). */
  | { type: "gsim/requestDocument"; requestId: string }
  /**
   * Cross-webview drag bridge: the extension host broadcasts the block being
   * dragged out of the library view so the schematic webview can complete the
   * drop. `blockName: null` means the drag ended.
   */
  | { type: "gsim/dragState"; blockName: string | null; label?: string }
  /** Insert a block into this schematic editor (relayed library click). */
  | { type: "gsim/insertBlock"; blockName: string }
  /**
   * A keyboard shortcut VS Code claimed, handed to the schematic instead.
   *
   * A webview only sees a keystroke the workbench did not take first, so every chord VS Code
   * binds at the workbench level — `Ctrl+R` is its recent-files list — never reached the
   * canvas. The extension contributes those chords with a `when` clause limited to a focused
   * schematic and relays them here.
   *
   * `chord` is the schematic keymap's own spelling, e.g. `Ctrl+Shift+R`.
   */
  | { type: "gsim/forwardedChord"; chord: string }
  /** Waveform panel should show the results of this sim id. */
  | { type: "gsim/showSimulation"; simId: string }
  /**
   * The answer to a `gsim/runSimulation` (#159), which always arrives.
   *
   * One reply per request, carrying an outcome rather than resolving or
   * rejecting: every way a run can end is something the user needs told, and a
   * Run click that produces no message at all is the failure mode this whole
   * path exists to end (#130, #147).
   */
  | { type: "gsim/runResult"; requestId: string; result: RunResult }
  /** The workspace's user components changed — merge them into the catalog. */
  | { type: "gsim/userSymbols"; metadata: unknown[] }
  /** A component was written to disk; carries the file it landed in. */
  | { type: "gsim/symbolSaved"; name: string; path: string }
  /** Answer to `gsim/readSource`: the file's text, or why it could not be read. */
  | { type: "gsim/sourceContent"; requestId: string; text?: string; error?: string }
  /**
   * Answer to `gsim/openBlockSource`, which always arrives.
   *
   * An outcome rather than a resolve-or-reject, for the reason `gsim/runResult`
   * gives: a double-click that produces nothing at all is indistinguishable
   * from a double-click the editor did not notice, and the user repeats it.
   */
  | { type: "gsim/blockSourceOpened"; requestId: string; result: OpenBlockSourceResult }
  /**
   * Answer to a `gsim/readSamples` (#157), which always arrives.
   *
   * An outcome rather than a resolve-or-reject, for the reason `gsim/runResult`
   * gives: a viewer waiting on bytes that never come shows an empty plot, and
   * an empty plot presented as a result is the failure FE-146 reported.
   */
  | { type: "gsim/samplesBytes"; requestId: string; result: SamplesReadResult }
  | { type: "gsim/symbolSaveFailed"; name: string; reason: string }
  /** Integration-harness only: run a probe inside this webview. */
  | { type: "gsim/test/exec"; requestId: string; op: string; args?: Record<string, unknown> };

export const GSIM_INIT_GLOBAL = "__GSIM_INIT__";

/**
 * Narrow an untrusted `message` from a webview to the protocol.
 *
 * Shape only — it asserts the envelope is an object carrying a `gsim/`-prefixed
 * `type`, not that the payload matches that type's own shape.
 */
export function isHostBoundMessage(value: unknown): value is HostBoundMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    (value as { type: string }).type.startsWith("gsim/")
  );
}
