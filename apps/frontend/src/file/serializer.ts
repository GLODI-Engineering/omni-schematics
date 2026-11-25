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

export function serialize(document: ModelDocument): string {
  assertSerializableDocument(document);
  return JSON.stringify(canonicalize(document));
}

export const serializeModel = serialize;

export default serialize;
