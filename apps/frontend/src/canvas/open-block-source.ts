/**
 * Double-clicking a scripted block opens its source in VS Code (#212).
 *
 * The reason this editor was put inside VS Code: a `pyfunc` block is a Python
 * file, and what the user wants on it is Python tooling — completion, type
 * checking, go to definition, a debugger — not a text box of our own. All of
 * that arrives for free the moment the file is open in a real editor, with no
 * code here beyond asking for it.
 *
 * Its own module rather than a closure inside `Canvas.tsx` so that the decision
 * — which file, what to put in it when it is missing, what to say when nothing
 * can be opened — is testable without a canvas.
 */
import { requestOpenBlockSource } from "../ipc/vscode-host";
import { scriptedSourceFor, sourceStub } from "../netlist/code-source";
import type { ScriptedBlock } from "../netlist/code-source";
import { useToastStore } from "../store/toast";

export { isScriptedBlockType } from "../netlist/code-source";

/**
 * Open the block's source, and say something whatever happens.
 *
 * Every branch reports. A double-click that produces nothing at all is
 * indistinguishable from one the editor did not notice, so the user does it
 * again and then concludes the feature is missing — which is the state #212
 * describes.
 */
export async function openBlockSource(block: ScriptedBlock): Promise<void> {
  const toast = useToastStore.getState().pushToast;
  const source = scriptedSourceFor(block);

  if (!source) {
    toast(`${block.id} has no source file yet — set its Path in the inspector.`);
    return;
  }

  const result = await requestOpenBlockSource({
    blockId: block.id,
    candidates: source.candidates,
    create: source.create,
    stub: sourceStub(block),
  });

  if (result === null) {
    // No extension host: the Vite harness, or a reply that never came.
    toast("A block's source can only be opened inside the editor.");
    return;
  }
  if (!result.ok) {
    toast(result.reason);
    return;
  }
  if (result.created) {
    toast(`Created ${source.create} — fill in the body and build or run it.`);
  }
}
