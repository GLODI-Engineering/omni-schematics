/**
 * The geometry of a block's *library tile* — #213.
 *
 * A tile is not a canvas symbol made small. The canvas symbol's SVG is sized
 * to the block's bounding box and draws its port stubs, terminal markers and
 * port labels *outside* it, which works there because the canvas sets
 * `overflow: visible`. Dropped into a fixed tile with `overflow: hidden`, all
 * 68 catalogue entries drew past their own viewBox and were cut off at the
 * edge; the three `math.fn*` entries and the two latches lost their input
 * leads entirely, which is what the owner reported as "ports mismatch".
 *
 * So the tile computes its own view: the block's box, grown by a short stub
 * reach and a hair of padding, with the artwork fitted into it. Two things
 * follow that the canvas path cannot give:
 *
 * - **Nothing is clipped.** The view contains every point the tile draws, and
 *   `tile-art.test.ts` checks that for the whole catalogue.
 * - **The caption is drawn in tile space.** A generic block's `symbol.text` is
 *   12 units tall inside a box up to 80 units wide; scaled into a 36 px tile
 *   that is a smudge. Handing the caption back separately lets `BlockTile`
 *   size it against the tile instead of against the drawing.
 *
 * What is *not* here: colour, stroke weight and font size. Those are the
 * tile's presentation, not its geometry, and they live in `BlockTile.tsx` and
 * the stylesheet so they can follow the VS Code theme.
 */

import { getSchematicSymbol } from "../canvas/nodes/component-symbols";
import { SYMBOL_SCALE, getMetadataPortCenters } from "../canvas/nodes/port-hit-test";
import { type Primitive, metadataToPrimitives } from "../canvas/nodes/primitive-renderer";
import { resolveBlockBbox } from "../canvas/nodes/resolve-ports";
import type { Block, BlockMetadata, ParamValue } from "../model/types";

/**
 * How far a tile's port lead reaches out of the body, in bbox units.
 *
 * The canvas uses `STUB_LEN = 20` *scaled* units — a whole grid square, so a
 * wire has somewhere to land. Nothing lands on a tile, and a lead that long
 * would be a third of the picture, so the tile draws a stump: enough to say
 * "a port is here, and there are three of them on the left", which is the
 * only thing that tells `math.fn1` from `math.fn3` at this size.
 */
export const TILE_STUB = 7;

/**
 * Slack around the drawing, in bbox units, so an outline's stroke is not
 * shaved off by the viewport edge. Strokes straddle the path, and a rect
 * drawn exactly on the box outline would lose its outer half.
 */
export const TILE_PAD = 2;

export interface TileStub {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TileView {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TileArt {
  /** The tile's viewBox, in bbox units. Contains everything below. */
  view: TileView;
  /** Short port leads. Empty when the artwork draws its own. */
  stubs: TileStub[];
  /** Body shapes, in bbox units. Empty when a hand-drawn symbol supplies them. */
  shapes: Primitive[];
  /** The block's caption, for the tile to size itself. Never baked into `shapes`. */
  caption?: string;
  /** True when `component-symbols` has real artwork for this type. */
  handDrawn: boolean;
  /** The block's own box, which the hand-drawn artwork is contracted to stay inside. */
  bbox: [number, number];
}

/** A catalogue entry's parameters at their declared defaults. */
export function defaultTileParams(metadata: BlockMetadata): Record<string, ParamValue> {
  return Object.fromEntries(
    (metadata.params ?? []).map((param) => [param.name, (param.default ?? null) as ParamValue]),
  );
}

function fakeBlock(metadata: BlockMetadata, params: Record<string, ParamValue>): Block {
  return {
    id: metadata.name,
    type: metadata.name,
    paradigm: "signal-flow",
    domain: "signal",
    fidelity: "n_a",
    position: [0, 0],
    rotation: 0,
    mirror: "none",
    params,
    ic: {},
  };
}

function interpolate(template: string, params: Record<string, ParamValue>): string {
  return template.replace(/\{([a-z][a-z0-9_]*)\}/gi, (_, name: string) =>
    String(params[name] ?? `{${name}}`),
  );
}

/** The hand-drawn artwork for this type, if `component-symbols` has any. */
export function tileSchematic(metadata: BlockMetadata) {
  const type = "type" in metadata ? String(metadata.type) : undefined;
  const aliases = Array.isArray(metadata.aliases) ? metadata.aliases : [];
  return getSchematicSymbol(metadata.name, type, ...aliases);
}

/** Does this entry have hand-drawn artwork rather than a generic box? */
export function tileArt(
  metadata: BlockMetadata,
  params: Record<string, ParamValue> = defaultTileParams(metadata),
): TileArt {
  const bbox = resolveBlockBbox(metadata, params);
  const schematic = tileSchematic(metadata);
  const handDrawn = schematic !== undefined;

  const stubs: TileStub[] =
    schematic?.selfDrawnPorts === true
      ? []
      : getMetadataPortCenters(fakeBlock(metadata, params), metadata).map((port) => {
          const x = port.center.x / SYMBOL_SCALE;
          const y = port.center.y / SYMBOL_SCALE;
          const dx = port.rotatedSide === "left" ? -1 : port.rotatedSide === "right" ? 1 : 0;
          const dy = port.rotatedSide === "top" ? -1 : port.rotatedSide === "bottom" ? 1 : 0;
          return { x1: x, y1: y, x2: x + dx * TILE_STUB, y2: y + dy * TILE_STUB };
        });

  // A hand-drawn symbol is a React render, not a primitive list, so the tile
  // cannot inspect it; the drawing contract in `symbol-drawing.tsx` is that it
  // stays inside the box it is handed, and the box is what the view uses.
  // A custom (document-authored) path is the same case.
  const shapes: Primitive[] =
    handDrawn || metadata.symbol.shape === "custom"
      ? []
      : metadataToPrimitives(metadata, params).filter((shape) => shape.type !== "text");

  const caption =
    handDrawn || !metadata.symbol.text ? undefined : interpolate(metadata.symbol.text, params);

  let minX = -TILE_PAD;
  let minY = -TILE_PAD;
  let maxX = bbox[0] + TILE_PAD;
  let maxY = bbox[1] + TILE_PAD;
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x - TILE_PAD);
    minY = Math.min(minY, y - TILE_PAD);
    maxX = Math.max(maxX, x + TILE_PAD);
    maxY = Math.max(maxY, y + TILE_PAD);
  };
  for (const stub of stubs) {
    grow(stub.x1, stub.y1);
    grow(stub.x2, stub.y2);
  }
  for (const shape of shapes) {
    switch (shape.type) {
      case "rect":
      case "rectf":
        grow(shape.x, shape.y);
        grow(shape.x + shape.w, shape.y + shape.h);
        break;
      case "circle":
      case "arc":
        grow(shape.cx - shape.r, shape.cy - shape.r);
        grow(shape.cx + shape.r, shape.cy + shape.r);
        break;
      case "line":
        grow(shape.x1, shape.y1);
        grow(shape.x2, shape.y2);
        break;
      case "polygon":
      case "polyline":
        for (const point of shape.pts) {
          grow(point[0] as number, point[1] as number);
        }
        break;
      case "text":
        break;
    }
  }

  return {
    view: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    stubs,
    shapes,
    caption,
    handDrawn,
    bbox,
  };
}

export default tileArt;
