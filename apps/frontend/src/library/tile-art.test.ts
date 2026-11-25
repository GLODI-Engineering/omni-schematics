/**
 * #213 — a tile is not a shrunken canvas symbol.
 *
 * The library used to render the canvas `BlockSymbol` into a 56×40 box with
 * `overflow: hidden`. That SVG is sized to the block's bbox and draws its port
 * stubs *outside* it, relying on `overflow: visible`; inside the tile every one
 * of the 68 entries drew past its own viewBox and was cut off at the edge.
 *
 * So the tile gets its own geometry, and these are its two promises: the whole
 * drawing is inside the view, and the view keeps the block's aspect ratio
 * honest so a 60×132 flip-flop is not squashed into the same oblong as a 60×40
 * gain.
 */

import { describe, expect, it } from "vitest";

import { STUB_LEN, SYMBOL_SCALE } from "../canvas/nodes/port-hit-test";
import type { BlockMetadata } from "../model/types";
import { loadCatalogFromManifest } from "./catalog";
import { TILE_PAD, TILE_STUB, defaultTileParams, tileArt } from "./tile-art";

const CATALOG = Object.values(loadCatalogFromManifest());

function entry(name: string): BlockMetadata {
  const found = CATALOG.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`catalogue has no ${name}`);
  return found;
}

/** Every point the tile draws, in view coordinates. */
function drawnPoints(art: ReturnType<typeof tileArt>): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (const stub of art.stubs) {
    pts.push([stub.x1, stub.y1], [stub.x2, stub.y2]);
  }
  // The hand-drawn artwork is contracted to stay inside the block's bbox
  // (see `symbol-drawing.tsx`), so the bbox corners stand in for it.
  pts.push([0, 0], [art.bbox[0], art.bbox[1]]);
  for (const shape of art.shapes) {
    switch (shape.type) {
      case "rect":
      case "rectf":
        pts.push([shape.x, shape.y], [shape.x + shape.w, shape.y + shape.h]);
        break;
      case "circle":
        pts.push(
          [shape.cx - shape.r, shape.cy - shape.r],
          [shape.cx + shape.r, shape.cy + shape.r],
        );
        break;
      case "line":
        pts.push([shape.x1, shape.y1], [shape.x2, shape.y2]);
        break;
      case "arc":
        pts.push(
          [shape.cx - shape.r, shape.cy - shape.r],
          [shape.cx + shape.r, shape.cy + shape.r],
        );
        break;
      case "polygon":
      case "polyline":
        pts.push(...shape.pts);
        break;
      case "text":
        break;
    }
  }
  return pts;
}

describe("#213: tile art stays inside the tile's own viewBox", () => {
  it("every catalogue entry draws inside its view", () => {
    const outside: string[] = [];
    for (const metadata of CATALOG) {
      const art = tileArt(metadata, defaultTileParams(metadata));
      const { x, y, w, h } = art.view;
      for (const [px, py] of drawnPoints(art)) {
        if (px < x || py < y || px > x + w || py > y + h) {
          outside.push(`${metadata.name} draws (${px}, ${py}) outside ${x},${y},${w},${h}`);
          break;
        }
      }
    }
    expect(outside).toEqual([]);
  });

  it("the view is the bbox grown by the stub reach, not the bare bbox", () => {
    // math.fn2 has two inputs on the left and one output on the right, so the
    // stubs push the view out on both sides — this is the entry that was
    // clipped worst.
    const art = tileArt(entry("math.fn2"));
    expect(art.stubs.length).toBe(3);
    expect(art.view.x).toBeLessThanOrEqual(-TILE_STUB);
    expect(art.view.w).toBeGreaterThanOrEqual(art.bbox[0] + 2 * TILE_STUB);
  });

  it("pads a block with no ports so its outline is not shaved by the edge", () => {
    const art = tileArt(entry("routing.ground"));
    expect(art.view.x).toBeLessThanOrEqual(-TILE_PAD);
    expect(art.view.y).toBeLessThanOrEqual(-TILE_PAD);
    expect(TILE_PAD).toBeGreaterThan(0);
    expect(art.view.w).toBeGreaterThan(art.bbox[0]);
    expect(art.view.h).toBeGreaterThan(art.bbox[1]);
  });

  it("keeps the block's aspect ratio: a flip-flop's view is taller than it is wide", () => {
    const ff = tileArt(entry("logic.flip_flop"));
    const gain = tileArt(entry("control.gain"));
    expect(ff.view.h / ff.view.w).toBeGreaterThan(1);
    expect(gain.view.h / gain.view.w).toBeLessThan(1);
  });
});

describe("#213: the tile's caption is the tile's, not the canvas drawing's", () => {
  it("hands a generic block's symbol text back as a caption to size in tile space", () => {
    const art = tileArt(entry("control.transform.clarke"));
    expect(art.handDrawn).toBe(false);
    expect(art.caption).toBe("abc/αβ0");
    // The caption must not also be baked into the scaled artwork, or it is
    // drawn twice and the crushed copy is the one that was unreadable.
    expect(art.shapes.some((shape) => shape.type === "text")).toBe(false);
  });

  it("interpolates a parameterised caption against the block's defaults", () => {
    // No shipped generic block carries a `{param}` caption today — every type
    // that does (`control.gain`, `logic.gate`, the `math.fn*` family) has
    // hand-drawn artwork — so this pins the substitution on a block built for
    // it rather than on data that could stop exercising it tomorrow.
    const parameterised = {
      ...entry("control.state_space"),
      name: "test.parameterised",
      params: [{ name: "fn", label: "Function", type: "string", default: "tanh" }],
      symbol: { bbox: [60, 40], shape: "rect", text: "{fn}" },
    } as unknown as BlockMetadata;
    expect(tileArt(parameterised).caption).toBe("tanh");
  });

  it("leaves a hand-drawn symbol to draw itself", () => {
    const art = tileArt(entry("passive.resistor"));
    expect(art.handDrawn).toBe(true);
    expect(art.shapes).toEqual([]);
    expect(art.caption).toBeUndefined();
  });

  it("draws a stump, not the canvas's full-length lead", () => {
    // The canvas lead is STUB_LEN = 20 *scaled* units, a whole grid square, so
    // a wire has somewhere to land. Nothing lands on a tile, and at tile scale
    // a lead that long is a third of the picture.
    const art = tileArt(entry("passive.resistor"));
    expect(art.stubs.length).toBe(2);
    for (const stub of art.stubs) {
      expect(Math.hypot(stub.x2 - stub.x1, stub.y2 - stub.y1)).toBe(TILE_STUB);
    }
    expect(TILE_STUB).toBeLessThan(STUB_LEN / SYMBOL_SCALE);
  });
});
