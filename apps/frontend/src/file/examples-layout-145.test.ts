/**
 * #145 — an example must be readable when opened and meaningful when run.
 *
 * Both faults here were invisible to every gate because both are properties of the
 * document that only matter once something draws or solves it.
 *
 * **Overlap.** `auto_arrange()` placed the blocks on a 40-unit grid. Symbols are
 * 60x40 in symbol units and `SYMBOL_SCALE` is 2, so they occupy 120x80 document
 * units -- three times the spacing they were given. The committed buck put nine
 * blocks at x = 0, 40, 80, 120, 160, 200, so every symbol sat on top of its
 * neighbour and the sheet rendered as an unreadable pile. The symbols themselves
 * are fine; rendered alone each one draws correctly. This is spacing.
 *
 * The check uses `getBlockBoundingBox`, the renderer's own function, rather than a
 * local rectangle calculation. That is the point: a check that computes geometry
 * its own way can agree with itself while disagreeing with what is on screen, and
 * "looks fine to the gate, terrible on screen" is the bug being fixed.
 *
 * **Analysis.** Every example carried `"simulation": {}`, so `buildAnalysisPayload`
 * found nothing, fell back to the v1 sim-settings store and ran its default
 * t_end = 10 s -- on converters switching at 100 kHz. A million switching periods
 * sampled a few thousand times. The solve "completed" and the waveform held
 * nothing readable.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getBlockBoundingBox } from "../canvas/geometry";
import type { BlockMetadata } from "../library/types";
import { deserialize } from "./deserializer";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const EXAMPLES = join(ROOT, "examples");

const files = readdirSync(EXAMPLES)
  .filter((name) => name.endsWith(".gsim_sch"))
  .sort();

/** The committed engine catalogue, keyed by block type — no engine needed. */
const catalog: Record<string, BlockMetadata> = Object.fromEntries(
  (
    JSON.parse(
      readFileSync(join(ROOT, "apps/frontend/src/library/engine-catalog.json"), "utf8"),
    ) as { metadata: BlockMetadata }[]
  ).map((entry) => [entry.metadata.name, entry.metadata]),
);

function boxesOf(name: string) {
  const document = deserialize(readFileSync(join(EXAMPLES, name), "utf8"));
  return document.model.blocks.map((block) => ({
    id: block.id,
    type: block.type,
    box: getBlockBoundingBox(block, catalog[block.type] ?? null),
  }));
}

/** Do two axis-aligned rectangles share any area? Touching edges do not count. */
function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("every example is laid out so it can be read", () => {
  it("finds the examples and the catalogue", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(Object.keys(catalog).length).toBeGreaterThan(0);
  });

  it.each(files)("%s has no two blocks overlapping", (name) => {
    const placed = boxesOf(name);
    const collisions: string[] = [];
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        if (overlaps(placed[i].box, placed[j].box)) {
          collisions.push(
            `${placed[i].id} (${placed[i].type}) overlaps ${placed[j].id} (${placed[j].type})`,
          );
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it.each(files)("%s knows the size of every symbol it places", (name) => {
    // Without this, a block type missing from the committed catalogue silently
    // gets the [96, 48] fallback and the overlap check above measures a fiction.
    for (const { id, type } of boxesOf(name)) {
      expect(catalog[type], `${id}: ${type} is not in engine-catalog.json`).toBeDefined();
    }
  });
});

describe("every example says how it should be simulated", () => {
  it.each(files)("%s carries a default analysis", (name) => {
    const document = deserialize(readFileSync(join(EXAMPLES, name), "utf8"));
    const simulation = document.model.simulation as
      | { default_analysis?: string; analyses?: { id: string; type: string }[] }
      | undefined;

    expect(simulation?.default_analysis, "no default_analysis").toBeTruthy();
    const analyses = simulation?.analyses ?? [];
    expect(analyses.length).toBeGreaterThan(0);
    // Named, not merely present: a `default_analysis` pointing at nothing leaves the
    // run falling back to the store defaults just as silently as an empty block.
    expect(analyses.map((analysis) => analysis.id)).toContain(simulation?.default_analysis);
  });

  it.each(files)("%s resolves its switching period at least 20 times", (name) => {
    // The fault was not only "no analysis". It was a window that made the result
    // unreadable, and a window can be wrong in the same way again. Every example
    // here switches at 100 kHz (PERIOD = 10e-6 in each generator), so a t_step
    // coarser than a twentieth of that period cannot show a switching edge.
    const document = deserialize(readFileSync(join(EXAMPLES, name), "utf8"));
    const simulation = document.model.simulation as {
      default_analysis?: string;
      analyses?: { id: string; t_step?: number; t_end?: number; t_start?: number }[];
    };
    const analysis = (simulation.analyses ?? []).find(
      (candidate) => candidate.id === simulation.default_analysis,
    );
    expect(analysis).toBeDefined();
    const SWITCHING_PERIOD = 10e-6;
    expect(analysis?.t_step).toBeGreaterThan(0);
    expect(analysis?.t_step).toBeLessThanOrEqual(SWITCHING_PERIOD / 20);
    // And long enough to be worth plotting: at least ten switching periods.
    expect(analysis?.t_end ?? 0).toBeGreaterThan(SWITCHING_PERIOD * 10);
  });
});
