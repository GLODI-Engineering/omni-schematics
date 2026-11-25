/**
 * Telling apart two catalogue entries that answer to the same name — #213.
 *
 * The engine's library ships two pairs whose `label` is identical:
 *
 * | name | label | caption |
 * | --- | --- | --- |
 * | `signal.step` | Step | `Step` |
 * | `signal_flow.source.step` | Step | `step` |
 * | `sinks.scope` | Scope | `Scope` |
 * | `signal_flow.sink.scope` | Scope | `scope` |
 *
 * They are not duplicates to delete: each has its own `equation_template` and
 * each is `compilable`, so the engine really does offer two of them, and the
 * catalogue is generated from the engine — the front end does not get to edit
 * it. What the front end can do is stop showing a human two rows with the same
 * word in them and no way to choose.
 *
 * The qualifier is the block's engine name, because that is the thing that
 * actually differs and the thing the user will see again in the netlist, in
 * the inspector and in a compile error. A prettier invention would be a third
 * name for the same block.
 *
 * Only colliding labels are qualified. Hanging `passive.resistor` off every
 * "Resistor" row would double the text in a 282 px panel to say nothing.
 */

import type { BlockMetadata } from "../model/types";

/** Block name → the qualifier its row should show, for colliding labels only. */
export function qualifiersForCollidingLabels(
  entries: ReadonlyArray<Pick<BlockMetadata, "name" | "label">>,
): Map<string, string> {
  const byLabel = new Map<string, string[]>();
  for (const entry of entries) {
    const key = entry.label.trim().toLowerCase();
    const names = byLabel.get(key);
    if (names) {
      if (!names.includes(entry.name)) names.push(entry.name);
    } else {
      byLabel.set(key, [entry.name]);
    }
  }

  const qualifiers = new Map<string, string>();
  for (const names of byLabel.values()) {
    if (names.length < 2) continue;
    for (const name of names) {
      qualifiers.set(name, name);
    }
  }
  return qualifiers;
}

export default qualifiersForCollidingLabels;
