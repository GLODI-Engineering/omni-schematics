/**
 * Whether a `cscript` block's compiled library is older than the source it came from (#235).
 *
 * ## The defect
 *
 * Nothing compiled a C block and nothing compared timestamps. The engine never compiles —
 * `cscript-ffi`'s module doc and the CLI's own help both say the user builds the library and
 * "this CLI never invokes a compiler". The extension never compiled either; `run-simulation.ts`
 * said so in as many words. So the full sequence for a user was: edit `ctrl.c` in the tab this
 * editor opened for them, press Run, and get a result computed by the previous build.
 *
 * Measured against `general-simulator` 0.8.0: a one-input one-output block,
 * `out[0] = 2.0 * in[0]`, compiled; then the source edited to `10.0 * in[0]` and **not** rebuilt:
 *
 * ```text
 * $ ls --time-style=+%T -l gain.c gain.so
 * 02:29:05 gain.c
 * 02:28:25 gain.so
 * ```
 *
 * ```text
 * t,…,VPROBE,G1
 * 0.00002,…,0.0006216883,0.0012433766
 * ```
 *
 * `0.0012433766 = 2 x 0.0006216883`. The source says 10. The run exited 0, wrote a complete
 * container and a complete manifest, and said nothing.
 *
 * ## Why this is a refusal and not a warning
 *
 * Every other failure on this path is loud: a missing library refuses to load, a missing symbol
 * is named, an arity disagreement is refused before the first step, a non-finite output stops
 * the run. A stale library is the one case that produces a plausible wrong answer and calls it a
 * success — a user tuning a gain and watching the waveform not move will blame the circuit, the
 * solver or themselves, in that order.
 *
 * `omniSchematics.staleCodeBlock` exists so nobody is stuck: `refuse` (the default), `warn`, or
 * `ignore`. A setting rather than a prompt because Run should not grow a dialog, and because the
 * answer for a given project is the same every time.
 *
 * ## What this deliberately does not do
 *
 * **It does not build.** That is the next step and it is a bigger one than it looks, because a
 * real block is not one file: the pattern is a thin `cscript_*` adapter plus one or two *shared*
 * sources, built with `-I` for their headers, `-lm`, and `-D` defines derived from the same
 * parameter set that generates the netlist — a block is rebuilt per operating point so that its
 * constants and the circuit's agree. A build that omitted those defines would produce a block
 * whose constants disagree with the circuit it is wired into, and the run would then report a
 * confident wrong answer: this very issue, caused by the feature meant to fix it. So the check
 * ships without the build, and the build gets its own change with the defines in it.
 *
 * **It does not guess that a library is fresh.** When no source can be found — which is the
 * common case until the document states the link (#222), because the candidate list is this
 * editor's convention and a project with sources in `code/` and artifacts in
 * `code/runs/<case>/` matches none of it — the run says *that*, rather than passing silently.
 */

/** What the run request carries per code block. Structural, so this module imports nothing. */
export interface CodeBlockForCheck {
  blockId: string;
  language: "c" | "python" | "octave";
  artifact?: string;
  sourceCandidates: string[];
  inferredSource: boolean;
}

/** The filesystem, injected so every verdict below is testable without one. */
export interface Clockwork {
  /** Modification time in milliseconds, or `null` when the path does not exist. */
  modifiedAt: (absolutePath: string) => number | null;
  /** `path.resolve(base, relative)`, injected only so the tests need no real directory. */
  resolve: (relative: string) => string;
}

export type StaleAction = "refuse" | "warn" | "ignore";

export interface StaleFinding {
  blockId: string;
  /** Resolved absolute path of the library. */
  artifact: string;
  /** Resolved absolute path of the source, when one was found. */
  source?: string;
  /**
   * `stale` — the source is newer than the library.
   * `no-artifact` — the block names a library that is not there at all.
   * `no-source` — nothing was found to compare against.
   */
  kind: "stale" | "no-artifact" | "no-source";
  /** One sentence naming the block, the source and the library, and what to do. */
  message: string;
}

export interface StalenessVerdict {
  /** Findings that should stop the run, given the configured action. */
  blocking: StaleFinding[];
  /** Findings worth saying but not worth stopping for. */
  advisory: StaleFinding[];
}

/**
 * The staleness of every C block in a run.
 *
 * Only C: the other four languages name the file the engine reads, so there is no second
 * artifact for the source to get ahead of. A Python block whose `.py` the user just edited runs
 * the edit, which is the behaviour this is trying to restore for C.
 */
export function checkCodeBlockFreshness(
  blocks: readonly CodeBlockForCheck[],
  io: Clockwork,
  action: StaleAction,
): StalenessVerdict {
  const blocking: StaleFinding[] = [];
  const advisory: StaleFinding[] = [];
  if (action === "ignore") {
    return { blocking, advisory };
  }

  for (const block of blocks) {
    if (block.language !== "c" || block.artifact === undefined || block.artifact === "") {
      continue;
    }
    const artifact = io.resolve(block.artifact);
    const artifactAt = io.modifiedAt(artifact);

    // Which candidate is the source: the first that exists. The list is ordered best-first by
    // `code-source.ts`, and a candidate that is not on disk is not a source.
    let source: string | undefined;
    let sourceAt: number | null = null;
    for (const candidate of block.sourceCandidates) {
      const resolved = io.resolve(candidate);
      const at = io.modifiedAt(resolved);
      if (at !== null) {
        source = resolved;
        sourceAt = at;
        break;
      }
    }

    if (artifactAt === null) {
      // The engine will refuse this itself, with the loader's own reason, so this is not a
      // refusal — but saying it here names the *source* too, which the loader cannot.
      advisory.push({
        blockId: block.blockId,
        artifact,
        ...(source === undefined ? {} : { source }),
        kind: "no-artifact",
        message:
          `${block.blockId}: the library ${artifact} does not exist` +
          (source === undefined
            ? ". Build it from this block's source before running."
            : `. Build it from ${source} before running.`),
      });
      continue;
    }

    if (source === undefined || sourceAt === null) {
      advisory.push({
        blockId: block.blockId,
        artifact,
        kind: "no-source",
        message:
          `${block.blockId}: could not find the source behind ${artifact}, so this run cannot ` +
          "tell whether the library is up to date. " +
          (block.inferredSource
            ? `Looked for ${block.sourceCandidates.join(", ")}, which is this editor's ` +
              "convention rather than something the document states."
            : `Looked for ${block.sourceCandidates.join(", ")}.`),
      });
      continue;
    }

    if (sourceAt > artifactAt) {
      const finding: StaleFinding = {
        blockId: block.blockId,
        artifact,
        source,
        kind: "stale",
        message:
          `${block.blockId}: ${source} is newer than ${artifact}, so this run would simulate ` +
          "the previous build of this block and report success. Rebuild the library and run " +
          'again, or set "omniSchematics.staleCodeBlock" to "warn" if that is deliberate.',
      };
      if (action === "refuse") {
        blocking.push(finding);
      } else {
        advisory.push(finding);
      }
    }
  }

  return { blocking, advisory };
}
