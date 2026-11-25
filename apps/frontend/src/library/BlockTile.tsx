/**
 * A block's picture in the library list — #213.
 *
 * The library used to render the canvas `BlockSymbol` into a 56×40 box at
 * `width: 100%; height: 100%` with `overflow: hidden`. That is three separate
 * mistakes at once: the symbol's port stubs are drawn outside its SVG and were
 * cut off, percentage sizing threw the aspect ratio away so a 200×40 boundary
 * port and a 60×132 flip-flop came out the same oblong, and the body caption —
 * 12 units tall inside a box up to 80 units wide — was scaled down with the
 * drawing until `abc/αβ0` was a smudge.
 *
 * The tile is therefore its own presentation, not a smaller canvas:
 *
 * - The geometry comes from `tile-art.ts`, whose view contains every point the
 *   tile draws. The artwork goes in a nested `<svg>` with that view and
 *   `xMidYMid meet`, so the browser fits it and keeps its shape.
 * - The caption is drawn in the *outer* viewport, sized against the tile, and
 *   squeezed to the tile width rather than allowed to spill.
 * - Nothing here names a colour. Ink and paper are `STROKE`/`FILL`, which are
 *   CSS variables with the canvas's old literals as their fallback, so the
 *   panel can follow the VS Code theme while the canvas renders exactly as it
 *   did.
 */

import type { Primitive } from "../canvas/nodes/primitive-renderer";
import { FILL, STROKE } from "../canvas/nodes/symbol-drawing";
import type { BlockMetadata, ParamValue } from "../model/types";
import { type TileArt, defaultTileParams, tileArt, tileSchematic } from "./tile-art";

/**
 * Tile size in CSS pixels.
 *
 * Wide enough for a seven-character caption to stay readable (`abc/αβ0`,
 * `αβ0/dq0` — the transforms are the worst case), short enough that the row it
 * sits in is a VS Code list row rather than a card. The old tile was 56×40 in a
 * 57 px row and showed nine components in a 282 px panel.
 */
export const TILE_W = 40;
export const TILE_H = 20;

/** Caption type size in tile pixels, at most and at least. */
const CAPTION_MAX = 9;
const CAPTION_MIN = 6;
/** Left and right breathing room for the caption, in tile pixels. */
const CAPTION_INSET = 1.5;
/** Average glyph advance as a fraction of the font size, for the UI sans stack. */
const AVG_GLYPH_ADVANCE = 0.62;

export interface CaptionFit {
  fontSize: number;
  /**
   * Set when the caption still does not fit at {@link CAPTION_MIN}: SVG then
   * condenses the glyphs to exactly this width. Squeezed type is readable;
   * type that runs off the tile is not.
   */
  textLength?: number;
}

/** How big a tile caption may be drawn, and whether it has to be condensed. */
export function captionFit(text: string, width: number = TILE_W): CaptionFit {
  const inner = width - 2 * CAPTION_INSET;
  const naturalWidth = (size: number) => text.length * AVG_GLYPH_ADVANCE * size;
  const ideal = text.length > 0 ? inner / (text.length * AVG_GLYPH_ADVANCE) : CAPTION_MAX;
  const fontSize = Math.max(CAPTION_MIN, Math.min(CAPTION_MAX, ideal));
  return naturalWidth(fontSize) > inner ? { fontSize, textLength: inner } : { fontSize };
}

/**
 * One body shape, painted from the theme.
 *
 * `BlockSymbol`'s own primitive renderer hard-codes `#111827` and `#ffffff`,
 * and it also draws text — which the tile must size itself. Rather than widen
 * that renderer's contract for the one caller that needs different colours,
 * the tile paints the five shapes it can meet.
 */
function TileShape({ shape }: { shape: Primitive }) {
  switch (shape.type) {
    case "rect":
      return (
        <rect
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          fill={shape.filled ? STROKE : FILL}
          stroke={STROKE}
        />
      );
    case "rectf":
      return <rect x={shape.x} y={shape.y} width={shape.w} height={shape.h} fill={STROKE} />;
    case "circle":
      return (
        <circle
          cx={shape.cx}
          cy={shape.cy}
          r={shape.r}
          fill={shape.filled ? STROKE : FILL}
          stroke={STROKE}
        />
      );
    case "line":
      return (
        <line x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} stroke={STROKE} fill="none" />
      );
    case "polygon":
      return (
        <polygon
          points={shape.pts.map(([x, y]) => `${x},${y}`).join(" ")}
          fill={shape.filled ? STROKE : FILL}
          stroke={STROKE}
        />
      );
    case "polyline":
      return (
        <polyline
          points={shape.pts.map(([x, y]) => `${x},${y}`).join(" ")}
          fill="none"
          stroke={STROKE}
        />
      );
    default:
      return null;
  }
}

function shapeKey(shape: Primitive, index: number): string {
  return `${shape.type}-${index}`;
}

/** Length of a port lead on a boxed tile, in tile pixels. */
const TILE_LEAD = 3;
/** Clearance between the box and the tile edge where no lead needs the room. */
const TILE_MARGIN = 0.75;

/**
 * Whether this entry is a labelled rectangle and nothing more.
 *
 * Every generic entry in the shipped catalogue is — the circles and the
 * triangle all have hand-drawn artwork — and a labelled rectangle is the one
 * case where the block's own proportions say nothing. The engine sized that
 * box to fit its ports: `control.transform.clarke` is 80×66 because it has six
 * of them, not because a Clarke transform is squarer than a PID controller.
 * Fitting those proportions into the tile shrank the box until its caption no
 * longer fitted inside it and `abc/αβ0` was drawn straight across the outline.
 */
function isLabelledBox(art: TileArt): boolean {
  return !art.handDrawn && art.shapes.length === 1 && art.shapes[0]?.type === "rect";
}

export interface TileBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The rectangle a labelled box fills, in tile pixels: the whole tile, less the
 * room its leads need on the faces that have any.
 */
export function genericBox(art: TileArt, width = TILE_W, height = TILE_H): TileBox {
  const horizontal = art.stubs.some((stub) => stub.x1 !== stub.x2);
  const vertical = art.stubs.some((stub) => stub.y1 !== stub.y2);
  const padX = TILE_MARGIN + (horizontal ? TILE_LEAD : 0);
  const padY = TILE_MARGIN + (vertical ? TILE_LEAD : 0);
  return { x: padX, y: padY, w: width - 2 * padX, h: height - 2 * padY };
}

/** A labelled box drawn at tile proportions, with its leads where its ports are. */
function BoxedTile({ art, box }: { art: TileArt; box: TileBox }) {
  const [bw, bh] = art.bbox;
  return (
    <g className="block-tile__art">
      {art.stubs.map((stub) => {
        const x = box.x + (stub.x1 / bw) * box.w;
        const y = box.y + (stub.y1 / bh) * box.h;
        return (
          <line
            key={`${stub.x1},${stub.y1}-${stub.x2},${stub.y2}`}
            data-tile-stub=""
            x1={x}
            y1={y}
            x2={x + Math.sign(stub.x2 - stub.x1) * TILE_LEAD}
            y2={y + Math.sign(stub.y2 - stub.y1) * TILE_LEAD}
            stroke={STROKE}
            fill="none"
          />
        );
      })}
      <rect x={box.x} y={box.y} width={box.w} height={box.h} fill={FILL} stroke={STROKE} />
    </g>
  );
}

export interface BlockTileProps {
  entry: BlockMetadata;
  width?: number;
  height?: number;
}

export function BlockTile({ entry, width = TILE_W, height = TILE_H }: BlockTileProps) {
  const params: Record<string, ParamValue> = defaultTileParams(entry);
  const art = tileArt(entry, params);
  const schematic = tileSchematic(entry);
  const caption = art.caption;
  const boxed = isLabelledBox(art) ? genericBox(art, width, height) : null;
  // A caption belongs inside its box, not across the tile: the width it has to
  // live in is the box's, and only an unboxed drawing gets the whole tile.
  const fit = caption ? captionFit(caption, boxed ? boxed.w : width) : null;

  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: the tile is a picture of the row's component and is aria-hidden; the row's own aria-label names it, and a <title> here would put the name in the accessibility tree twice.
    <svg
      className="block-tile"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      {boxed ? (
        <BoxedTile art={art} box={boxed} />
      ) : (
        // biome-ignore lint/a11y/noSvgWithoutTitle: the inner viewport is the fitting mechanism, not a graphic of its own; the whole tile is aria-hidden and the row's aria-label names the component.
        <svg
          className="block-tile__art"
          x={0}
          y={0}
          width={width}
          height={height}
          viewBox={`${art.view.x} ${art.view.y} ${art.view.w} ${art.view.h}`}
          preserveAspectRatio="xMidYMid meet"
        >
          {art.stubs.map((stub) => (
            <line
              key={`${stub.x1},${stub.y1}-${stub.x2},${stub.y2}`}
              data-tile-stub=""
              x1={stub.x1}
              y1={stub.y1}
              x2={stub.x2}
              y2={stub.y2}
              stroke={STROKE}
              fill="none"
            />
          ))}
          {schematic
            ? schematic.render({
                width: art.bbox[0],
                height: art.bbox[1],
                params,
                rotation: 0,
                mirror: "none",
              })
            : art.shapes.map((shape, index) => (
                <TileShape key={shapeKey(shape, index)} shape={shape} />
              ))}
        </svg>
      )}
      {caption && fit ? (
        <text
          className="block-tile__caption"
          x={boxed ? boxed.x + boxed.w / 2 : width / 2}
          y={boxed ? boxed.y + boxed.h / 2 : height / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={fit.fontSize}
          textLength={fit.textLength}
          lengthAdjust={fit.textLength ? "spacingAndGlyphs" : undefined}
          fill={STROKE}
        >
          {caption}
        </text>
      ) : null}
    </svg>
  );
}

export default BlockTile;
