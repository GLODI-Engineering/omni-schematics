import { useState } from "react";

import { openBlockSource } from "../canvas/open-block-source";
import { getWebviewInit, requestSource } from "../ipc/vscode-host";
import { type DerivedPorts, derivePortsFor } from "../netlist/code-ports";
import type { ScriptedBlock, ScriptedSource } from "../netlist/code-source";

interface SourcePortsProps {
  blockType: string;
  /** The block itself, so "Open file" can ask the host to open or create it. */
  block: ScriptedBlock;
  /** Where its source may live, best first — see `netlist/code-source.ts`. */
  source: ScriptedSource;
  /** Its `function` parameter, where the language has one. */
  functionName?: string;
  currentInputs: string[];
  currentOutputs: string[];
  onAdopt: (ports: { inputs?: string[]; outputs?: string[] }) => void;
}

const equal = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * What the source looks like it expects, beside what the block declares.
 *
 * A scripted block's ports live on the schematic and are handed to the
 * code, so the two can disagree with nothing noticing. This reads the file
 * and says what it found; adopting it is a click, never automatic, because
 * the parse is a shallow read of a signature and the person editing knows
 * things it does not — passing a vector through one port, for instance,
 * which is a perfectly ordinary thing to do.
 */
export function SourcePorts({
  blockType,
  block,
  source,
  functionName,
  currentInputs,
  currentOutputs,
  onAdopt,
}: SourcePortsProps) {
  const [state, setState] = useState<"idle" | "reading" | "done" | "unavailable" | "no-host">(
    "idle",
  );
  const [found, setFound] = useState<DerivedPorts | null>(null);

  async function read() {
    // Two different answers, and they used to be one. Outside VS Code there is
    // no host to ask and no workspace to read from, which is worth saying;
    // inside it, every candidate coming back empty means the file is not there
    // yet, which is a different sentence and a different next step.
    if (getWebviewInit() === null) {
      setState("no-host");
      return;
    }
    setState("reading");
    // In order, because a `cscript` block's parameter names a compiled library
    // and the source beside it is a convention with more than one spelling.
    for (const candidate of source.candidates) {
      const text = await requestSource(candidate);
      if (text === null) continue;
      setFound(derivePortsFor(blockType, text, functionName));
      setState("done");
      return;
    }
    setState("unavailable");
  }

  const inputsDiffer =
    found?.inputs !== null && found?.inputs !== undefined
      ? !equal(found.inputs, currentInputs)
      : false;
  const outputsDiffer =
    found?.outputs !== null && found?.outputs !== undefined
      ? !equal(found.outputs, currentOutputs)
      : false;

  return (
    <div className="source-ports">
      <div className="source-ports__actions">
        {/* Double-click on the block does this too; a button because a
            double-click is not something anyone discovers on their own. */}
        <button
          type="button"
          className="source-ports__open"
          title={`Open ${source.create} in a VS Code editor, beside the schematic`}
          onClick={() => void openBlockSource(block)}
        >
          Open file
        </button>
        <button type="button" className="source-ports__read" onClick={() => void read()}>
          {state === "reading" ? "Reading…" : "Read ports from source"}
        </button>
      </div>

      {source.inferred && (
        <p className="source-ports__note">
          This block's parameter names a compiled library, so its source is looked for by
          convention: {source.candidates.slice(0, 2).join(", ")}, …
        </p>
      )}

      {state === "no-host" && (
        <p className="source-ports__note">
          The source can only be read inside the editor, where there is a workspace to read from.
        </p>
      )}

      {state === "unavailable" && (
        <p className="source-ports__note">
          No source was found to read. "Open file" will offer to create {source.create}.
        </p>
      )}

      {state === "done" && found && (
        <div className="source-ports__result">
          <p className="source-ports__note">{found.note}</p>
          {found.inputs === null && found.outputs === null ? null : (
            <>
              {found.inputs && (
                <p className={`source-ports__row${inputsDiffer ? " is-different" : ""}`}>
                  inputs: {found.inputs.join(", ")}
                  {inputsDiffer ? " — differs from this block" : " — matches"}
                </p>
              )}
              {found.outputs && (
                <p className={`source-ports__row${outputsDiffer ? " is-different" : ""}`}>
                  outputs: {found.outputs.join(", ")}
                  {outputsDiffer ? " — differs from this block" : " — matches"}
                </p>
              )}
              {(inputsDiffer || outputsDiffer) && (
                <button
                  type="button"
                  className="source-ports__adopt"
                  onClick={() =>
                    onAdopt({
                      ...(found.inputs && inputsDiffer ? { inputs: found.inputs } : {}),
                      ...(found.outputs && outputsDiffer ? { outputs: found.outputs } : {}),
                    })
                  }
                >
                  Use these ports
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default SourcePorts;
