/**
 * The sheet's code blocks, as the run request carries them (#235).
 *
 * The host needs to know whether a `cscript` block's compiled library is older than the `.c` it
 * came from, and **the netlist cannot tell it**: that block's parameter is `lib`, a binary, and
 * the source is not named in the document at all. Only this side holds both the block and this
 * editor's convention for finding its source (`code-source.ts`), so the list is assembled here
 * and sent.
 *
 * Its own module rather than a closure in `shell/run.ts` for the reason `open-block-source.ts`
 * gives: the decision is worth asserting without a canvas, a store or a host.
 */
import { type ScriptedBlock, isScriptedBlockType, scriptedSourceFor } from "./code-source";

/** The shape the protocol carries. Declared structurally so this module stays dependency-free. */
export interface RunCodeBlock {
  blockId: string;
  language: "c" | "python" | "octave";
  artifact?: string;
  sourceCandidates: string[];
  inferredSource: boolean;
}

/** The slice of a model block this needs. Matches `schemas`' own `Block` structurally. */
export interface BlockLike {
  id: string;
  type: string;
  params?: Record<string, unknown>;
  subsystem?: { blocks?: BlockLike[] } | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Every code block on the sheet, including inside subsystems.
 *
 * Subsystems are walked because a code block inside one compiles into the same netlist as one
 * on the top sheet — the flattening happens in the compiler — so a stale library inside a
 * subsystem is exactly as wrong, and exactly as silent, as one on the sheet itself.
 */
export function runCodeBlocksFor(blocks: readonly BlockLike[] | undefined): RunCodeBlock[] {
  const out: RunCodeBlock[] = [];
  const walk = (list: readonly BlockLike[] | undefined): void => {
    for (const block of list ?? []) {
      if (isScriptedBlockType(block.type)) {
        const source = scriptedSourceFor({
          id: block.id,
          type: block.type,
          params: block.params ?? {},
        } satisfies ScriptedBlock);
        if (source) {
          const artifact = text(block.params?.lib);
          out.push({
            blockId: block.id,
            language: source.language,
            // Only `cscript` has an artifact distinct from its source; the other four name the
            // file the user edits, so there is nothing for it to go stale against.
            ...(block.type === "extensibility.cscript" && artifact !== "" ? { artifact } : {}),
            sourceCandidates: source.candidates,
            inferredSource: source.inferred,
          });
        }
      }
      walk(block.subsystem?.blocks);
    }
  };
  walk(blocks);
  return out;
}
