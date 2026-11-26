/**
 * Reading a code block's failure out of what the solver printed (#237).
 *
 * ## Why anything has to be parsed at all
 *
 * The engine is a separate process and its errors arrive as text on stderr. Three of the five
 * engine issues behind #239 were about making that text *say* where a failure happened
 * (`general-simulator#121`, `#122`, `#123`); this is the other half — turning what it now says
 * into `(file, line, column, message)` so a `Diagnostic` can be put on the line and clicked.
 *
 * Pure, and importing no `vscode`, so every grammar below is asserted against real engine and
 * real compiler output without an editor. `code-diagnostics.ts` is the thin half that owns the
 * `DiagnosticCollection`.
 *
 * ## The five shapes, and which of them carry a location
 *
 * | source | example | location |
 * | --- | --- | --- |
 * | Python traceback | `  File "./ctrl.py", line 10, in output` | **file, line, frame** |
 * | Python `SyntaxError` | `  File "./ctrl.py", line 1` | **file, line** |
 * | Octave | `Octave raised in /…/dbl.m: … near line 3, column 13` | **file, line, column** |
 * | `cc`/`clang` | `ctrl.c:7:14: error: use of undeclared identifier 'k'` | **file, line, column** |
 * | MSVC | `ctrl.c(7,14): error C2065: 'k': undeclared identifier` | **file, line, column** |
 * | C at run time | nothing | **none, by construction** |
 *
 * A C block's *runtime* failure has no location and will not get one: `cscript_output` returns
 * `void`, so there is no channel for a block to report a failure through, let alone a position
 * (`cscript-ffi`'s module doc says so, and `general-simulator`'s `DaeError::code_location`
 * returns `None` for every C-block failure deliberately). A C block's *build* failure does have
 * one, and it is the compiler's — which is the fourth and fifth rows above.
 *
 * ## Why the innermost Python frame
 *
 * A traceback's frames run outermost first, and the last one is where the exception was raised.
 * The engine execs the block's source with the user's real path as the code object's filename,
 * so every frame names a file the user can open — but only the last one is the line they need.
 *
 * ## What a failure with no location is for
 *
 * The commonest class of code-block failure has no file and line at all: a missing library, a
 * missing `output` function, an arity disagreement. Those are facts about **the document**, so
 * they are returned with no location and the caller attaches them to the `.gsim_sch` rather
 * than dropping them. A diagnostic on the sheet is clickable too, and "never nothing" is the
 * rule #237 asks for.
 */

/** Where a failure happened, when that is knowable. */
export interface FailureLocation {
  /** As the engine or compiler printed it: relative to the directory the run was spawned in. */
  file: string;
  /** 1-based, as every tool here reports it. */
  line: number;
  /** 1-based, when the tool gives one. */
  column?: number;
}

export interface CodeBlockFailure {
  /**
   * The engine's or compiler's own sentence — one line, for the Problems panel entry.
   *
   * A trailing `Traceback (most recent call last):` is trimmed off, because it is a heading for
   * the lines in `detail` and reads as a truncated message when shown alone.
   */
  message: string;
  /**
   * The lines that followed it — a Python traceback, a compiler's source echo and caret.
   *
   * Kept apart from `message` rather than folded into it because the two have different
   * readers: a Problems entry wants one line, and whoever opens it wants the frames. The
   * caller shows both.
   */
  detail?: string;
  /** Absent when the failure has no position — see the module doc. */
  location?: FailureLocation;
  /**
   * Which stream of diagnosis this came from. The caller shows both, and a reader needs to know
   * whether to fix a compile or a run.
   */
  origin: "solver" | "compiler";
  /** The block's netlist name, when the engine named one. */
  block?: string;
}

/**
 * `File "./ctrl.py", line 10, in output` — and `, in output` is optional.
 *
 * **Not anchored at the start of the line**, deliberately. A runtime traceback puts its frames
 * on their own lines, but a `SyntaxError` arrives inside the engine's own sentence:
 *
 * ```text
 * error: PyBlock(Load): failed to load Python block ./ctrl_syn.py:   File "./ctrl_syn.py", line 1
 * ```
 *
 * so an anchored pattern would find the runtime case and miss the load case — which is exactly
 * the half that already worked before `general-simulator#122`, and so exactly the half a test
 * written from one example would have covered.
 */
const PYTHON_FRAME = /File "(?<file>[^"]+)", line (?<line>\d+)(?:, in (?<frame>\S+))?/;

/**
 * `Octave raised in /…/dbl.m: … near line 3, column 13`
 *
 * Lazy up to the first `": "`, which is right on both platforms: a Windows path's colon
 * (`C:\proj\x.m`) is never followed by a space, so it cannot end the match early.
 */
const OCTAVE_FILE = /Octave raised in (?<file>.+?): /;
const OCTAVE_POSITION = /near line (?<line>\d+)(?:, column (?<column>\d+))?/;

/** `ctrl.c:7:14: error: …` and `ctrl.c:7: error: …` — gcc and clang. */
const GCC_DIAGNOSTIC =
  /^(?<file>[^\s:][^:]*):(?<line>\d+)(?::(?<column>\d+))?:\s*(?:fatal\s+)?(?<severity>error|warning|note):\s*(?<message>.*)$/;

/** `ctrl.c(7,14): error C2065: …` and `ctrl.c(7): error C2065: …` — MSVC. */
const MSVC_DIAGNOSTIC =
  /^(?<file>[^\s(][^(]*)\((?<line>\d+)(?:,(?<column>\d+))?\)\s*:\s*(?<severity>error|warning)\s+\w+\s*:\s*(?<message>.*)$/;

/** `error: CScriptArityMismatch: block `G1` …` — the engine's variant-name prefix. */
const ENGINE_ERROR = /^error:\s*(?<variant>[A-Za-z0-9_]+(?:\([A-Za-z0-9_]+\))?):\s*(?<rest>.*)$/;

/**
 * `Traceback (most recent call last):`, at the end of the engine's own sentence.
 *
 * It is a heading for the lines that follow, so a one-line Problems entry ending in it reads as
 * a message that was cut off. Trimmed from `message`; the lines themselves are in `detail`.
 */
const TRAILING_TRACEBACK_HEADING = /:?\s*Traceback \(most recent call last\):\s*$/;

/** A block name the engine quoted with backticks: ``block `G1` …``. */
const QUOTED_BLOCK = /block `(?<block>[^`]+)`/;

/**
 * Every code-block failure in a run's output.
 *
 * `lines` is what the solver printed, in order, stdout and stderr alike — the caller has them
 * separated and the distinction does not matter here: a traceback spans several lines and only
 * their order is load-bearing.
 *
 * One failure per `error:` line, with its location taken from whatever accompanies it. A
 * traceback's frames belong to the `error:` line they follow, which is why this is a scan with
 * state rather than a `filter`/`map`.
 */
export function readSolverFailures(lines: readonly string[]): CodeBlockFailure[] {
  const failures: CodeBlockFailure[] = [];
  let current: CodeBlockFailure | undefined;

  for (const raw of lines) {
    const engine = ENGINE_ERROR.exec(raw);
    if (engine?.groups) {
      const message = raw.replace(/^error:\s*/, "").replace(TRAILING_TRACEBACK_HEADING, "");
      current = {
        message,
        origin: "solver",
        ...(QUOTED_BLOCK.exec(message)?.groups?.block === undefined
          ? {}
          : { block: QUOTED_BLOCK.exec(message)?.groups?.block as string }),
      };
      // Octave puts everything on the one line: the file after `raised in`, the position in
      // the sentence Octave itself wrote.
      const octaveFile = OCTAVE_FILE.exec(message)?.groups?.file;
      const octavePosition = OCTAVE_POSITION.exec(message)?.groups;
      if (octaveFile !== undefined && octavePosition?.line !== undefined) {
        current.location = {
          file: octaveFile,
          line: Number(octavePosition.line),
          ...(octavePosition.column === undefined ? {} : { column: Number(octavePosition.column) }),
        };
      }
      // A Python `SyntaxError` is inside this same line; a runtime traceback is on the lines
      // after it, and the loop below fills that in.
      const inlineFrame = PYTHON_FRAME.exec(message)?.groups;
      if (inlineFrame?.file !== undefined && inlineFrame.line !== undefined) {
        current.location = { file: inlineFrame.file, line: Number(inlineFrame.line) };
      }
      failures.push(current);
      continue;
    }

    if (current === undefined) {
      continue;
    }

    const frame = PYTHON_FRAME.exec(raw);
    if (frame?.groups?.file !== undefined && frame.groups.line !== undefined) {
      // Overwrites deliberately: a traceback's frames run outermost first, and the last one is
      // where the exception was raised. That is the line the user needs.
      current.location = { file: frame.groups.file, line: Number(frame.groups.line) };
    }
    // Everything after the `error:` line belongs to it. A Problems entry showing only
    // `… raised in `output`: Traceback (most recent call last):` names no exception at all, and
    // the exception is the whole point: it is on the *last* line of the traceback.
    if (raw.trim() !== "") {
      current.detail = current.detail === undefined ? raw : `${current.detail}\n${raw}`;
    }
  }

  return failures;
}

/**
 * Every diagnostic in a compiler's output.
 *
 * Both grammars are tried on every line, because a build can be driven by a user's own command
 * and nothing says which compiler ran it. The two cannot both match the same line: gcc's form
 * puts the position after a colon and MSVC's inside parentheses.
 *
 * `note:` lines are dropped. They are continuations of the diagnostic above — "in expansion of
 * macro", "candidate function not viable" — and one Problems entry per note turns a single
 * mistake into five, which is how a Problems panel stops being read.
 */
export function readCompilerDiagnostics(lines: readonly string[]): CodeBlockFailure[] {
  const found: CodeBlockFailure[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    const match = GCC_DIAGNOSTIC.exec(line) ?? MSVC_DIAGNOSTIC.exec(line);
    if (!match?.groups) {
      continue;
    }
    const { file, severity, message } = match.groups;
    if (severity === "note") {
      continue;
    }
    found.push({
      message: `${severity}: ${message ?? ""}`.trim(),
      origin: "compiler",
      location: {
        file: file as string,
        line: Number(match.groups.line),
        ...(match.groups.column === undefined ? {} : { column: Number(match.groups.column) }),
      },
    });
  }
  return found;
}
