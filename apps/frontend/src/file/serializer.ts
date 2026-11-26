/**
 * Writing a `.gsim_sch`. The editor's writer, and the only one that runs on a
 * user's file.
 *
 * ## Why not the engine's `saveDocument`
 *
 * #174 asked exactly that, and the answer is that the engine's writer is a
 * compiler's: it drops `blocks[].subsystem` (an entire nested model),
 * `subckt_defs[].body` (a `.SUBCKT`'s SPICE text), `model.ports` and
 * `model.parent_param_aliases`. Saving through it would silently destroy any
 * document using one of them. All four are recorded, and asserted to still
 * happen, in `./engine-agreement.test.ts`; the open question of whether the
 * engine should carry them is #200. Until it does, this function stays, and
 * that test is what holds it to the engine's reading of the same document.
 *
 * ## The compact form is not a decision this file made on purpose
 *
 * `JSON.stringify` is called with no indent, so a document is written on one
 * line — while `examples/_builder.py` and the engine both pretty-print with
 * 2-space indent. The round-trip is lossless and idempotent either way, so
 * nothing is at risk; what suffers is `git diff` on a saved sheet. #201.
 */

import type { ModelDocument } from "../model/types";

function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
}

function assertCoordinatePair(point: [number, number], label: string): void {
  assertInteger(point[0], `${label}[0]`);
  assertInteger(point[1], `${label}[1]`);
}

function assertSerializableDocument(document: ModelDocument): void {
  assertInteger(document.model.grid, "model.grid");
  for (const block of document.model.blocks) {
    assertCoordinatePair(block.position, `block ${block.id} position`);
  }
  for (const wire of document.model.wires) {
    for (const [index, waypoint] of wire.waypoints.entries()) {
      assertCoordinatePair(waypoint, `wire ${wire.id} waypoints[${index}]`);
    }
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

/**
 * Two spaces and a trailing newline, because this file is the user's and lives in their
 * repository (#201).
 *
 * It used to be written on one line. Nothing was lost -- the round trip is semantically
 * identical and byte-idempotent after the first save -- but a `.gsim_sch` under version control
 * then produced one enormous changed line per edit, so `git diff` could say only *that* the
 * sheet changed, never what changed in it. Opening a shipped example and nudging one block
 * rewrote `buck_converter` from 7,535 bytes across 400-odd lines to 3,990 bytes on one.
 *
 * It also made the editor the only one of this format's three writers that did not pretty-print:
 * `examples/_builder.py` emits `indent=2`, and the engine's own `save_document` does the same.
 *
 * The cost is the IPC payload. `vscode/schematic-main.tsx` posts the whole text to the host on
 * every graph mutation and `lastSynced()` compares that text to decide whether anything changed,
 * so this roughly 1.9x's both -- about 36 KB for a 19 KB sheet, in a `postMessage` on the same
 * machine. That is the right trade against a permanent file nobody can read a diff of.
 *
 * Note this still does not make a saved sheet byte-identical to the one its generator emits:
 * Python and Rust write a float as `48.0` and JavaScript writes `48`, so the two differ at
 * every float-valued parameter whatever the indentation. That is its own issue.
 */
export function serialize(document: ModelDocument): string {
  assertSerializableDocument(document);
  return `${JSON.stringify(canonicalize(document), null, 2)}\n`;
}

export const serializeModel = serialize;

export default serialize;
