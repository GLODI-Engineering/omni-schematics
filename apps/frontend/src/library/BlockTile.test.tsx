/**
 * #213 — what the library tile promises on screen.
 *
 * Measured in a real VS Code before this change: all 68 tiles drew outside
 * their own viewBox, the artwork was stretched to the tile box so a 200×40
 * boundary port and a 60×132 flip-flop came out the same shape, and every
 * stroke and fill was a literal (`#0f172a` on `#ffffff`) inside a dark panel.
 *
 * These are assertions about those three things, not a snapshot of markup.
 */

import { cleanup, render } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { wireColorForDomain } from "../canvas/edges/wire-color";
import type { BlockMetadata, PortKindDomain } from "../model/types";
import { BlockTile, TILE_H, TILE_W, captionFit, genericBox } from "./BlockTile";
import { loadCatalogFromManifest } from "./catalog";
import { defaultTileParams, tileArt } from "./tile-art";

const CATALOG = Object.values(loadCatalogFromManifest());

const DOMAINS: PortKindDomain[] = [
  "signal",
  "signal-bus",
  "function-call",
  "physical-electrical",
  "physical-translational",
  "physical-rotational",
  "physical-thermal",
  "physical-signal",
  "mixed",
  "reserved.physical-magnetic",
  "reserved.physical-hydraulic",
  "reserved.physical-fluid",
];

function entry(name: string): BlockMetadata {
  const found = CATALOG.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`catalogue has no ${name}`);
  return found;
}

function tileOf(name: string): SVGSVGElement {
  const { container } = render(React.createElement(BlockTile, { entry: entry(name) }));
  const svg = container.querySelector("svg.block-tile");
  if (!svg) throw new Error("no tile rendered");
  return svg as unknown as SVGSVGElement;
}

afterEach(cleanup);

describe("#213: the tile fits the drawing instead of cropping it", () => {
  it("gives the artwork the view tile-art computed, not the bare bbox", () => {
    const art = tileArt(entry("math.fn3"), defaultTileParams(entry("math.fn3")));
    const art$ = tileOf("math.fn3").querySelector("svg.block-tile__art");
    expect(art$).not.toBeNull();
    expect(art$?.getAttribute("viewBox")).toBe(
      `${art.view.x} ${art.view.y} ${art.view.w} ${art.view.h}`,
    );
  });

  it("keeps the aspect ratio so a wide block is not stretched to tile shape", () => {
    for (const name of ["hierarchy.inport", "logic.flip_flop", "control.gain"]) {
      const art$ = tileOf(name).querySelector("svg.block-tile__art");
      expect(art$?.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
      cleanup();
    }
  });

  it("is the declared tile size", () => {
    const svg = tileOf("passive.resistor");
    expect(svg.getAttribute("width")).toBe(String(TILE_W));
    expect(svg.getAttribute("height")).toBe(String(TILE_H));
  });

  it("renders the hand-drawn artwork rather than an empty box", () => {
    const art$ = tileOf("passive.resistor").querySelector("svg.block-tile__art");
    expect(art$?.querySelectorAll("*").length).toBeGreaterThan(2);
  });

  it("draws a port stump for every port, inside the view", () => {
    const art$ = tileOf("math.fn3").querySelector("svg.block-tile__art");
    expect(art$?.querySelectorAll("line[data-tile-stub]").length).toBe(
      tileArt(entry("math.fn3")).stubs.length,
    );
  });
});

describe("#213: the caption is sized against the tile, not against the drawing", () => {
  it("draws a generic block's caption in tile space", () => {
    const text = tileOf("control.transform.clarke").querySelector("text.block-tile__caption");
    expect(text?.textContent).toBe("abc/αβ0");
    // Tile space, not the 80-unit-wide bbox the canvas draws it in.
    expect(Number(text?.getAttribute("font-size"))).toBeLessThanOrEqual(TILE_H / 2);
    expect(Number(text?.getAttribute("font-size"))).toBeGreaterThanOrEqual(5);
  });

  it("condenses a caption that will not fit at the legible floor, never spills it", () => {
    // 20 px is the narrowest box a tile can produce (a block with ports on all
    // four faces). Nine characters cannot be drawn in it at a readable size,
    // so the glyphs are squeezed to the width available instead of running out
    // over the outline, which is what the old tile did.
    const long = captionFit("I (PULSE)", 20);
    const short = captionFit("PID", 20);
    expect(long.textLength).toBeDefined();
    expect(long.textLength).toBeLessThanOrEqual(20);
    expect(short.textLength).toBeUndefined();
    expect(short.fontSize).toBeGreaterThan(long.fontSize);
  });

  it("keeps a seven-character transform caption readable without condensing it", () => {
    // `abc/αβ0` is the caption that made the owner call the tiles illegible.
    const clarke = entry("control.transform.clarke");
    const box = genericBox(tileArt(clarke), TILE_W, TILE_H);
    const fit = captionFit("abc/αβ0", box.w);
    expect(fit.textLength).toBeUndefined();
    expect(fit.fontSize).toBeGreaterThanOrEqual(6.5);
  });

  it("never squeezes a caption below a legible floor", () => {
    for (const metadata of CATALOG) {
      const caption = tileArt(metadata).caption;
      if (!caption) continue;
      expect(captionFit(caption, TILE_W).fontSize).toBeGreaterThanOrEqual(6);
    }
  });

  it("leaves a hand-drawn symbol to draw its own text", () => {
    expect(tileOf("control.gain").querySelector("text.block-tile__caption")).toBeNull();
  });
});

describe("#213: a labelled box is drawn at the tile's proportions", () => {
  it("fills the tile rather than shrinking to the engine's port-driven bbox", () => {
    // `control.transform.clarke` is 80x66 because it has six ports, not
    // because a Clarke transform is squarer than a PID controller. Fitting
    // those proportions left a box too small for its own caption, and
    // `abc/αβ0` was drawn straight across the outline.
    const rect = tileOf("control.transform.clarke").querySelector("rect");
    expect(rect).not.toBeNull();
    expect(Number(rect?.getAttribute("width"))).toBeGreaterThan(TILE_W * 0.6);
    expect(Number(rect?.getAttribute("height"))).toBeGreaterThan(TILE_H * 0.6);
  });

  it("keeps the caption inside the box it labels", () => {
    const svg = tileOf("control.transform.clarke");
    const rect = svg.querySelector("rect");
    const text = svg.querySelector("text.block-tile__caption");
    const boxLeft = Number(rect?.getAttribute("x"));
    const boxRight = boxLeft + Number(rect?.getAttribute("width"));
    const fit = captionFit("abc/αβ0", Number(rect?.getAttribute("width")));
    const half = (fit.textLength ?? "abc/αβ0".length * 0.62 * fit.fontSize) / 2;
    const centre = Number(text?.getAttribute("x"));
    expect(centre - half).toBeGreaterThanOrEqual(boxLeft);
    expect(centre + half).toBeLessThanOrEqual(boxRight);
  });

  it("keeps every lead inside the tile", () => {
    for (const metadata of CATALOG) {
      const svg = tileOf(metadata.name);
      for (const line of svg.querySelectorAll("g.block-tile__art line[data-tile-stub]")) {
        for (const [x, y] of [
          [Number(line.getAttribute("x1")), Number(line.getAttribute("y1"))],
          [Number(line.getAttribute("x2")), Number(line.getAttribute("y2"))],
        ]) {
          expect(x, metadata.name).toBeGreaterThanOrEqual(0);
          expect(x, metadata.name).toBeLessThanOrEqual(TILE_W);
          expect(y, metadata.name).toBeGreaterThanOrEqual(0);
          expect(y, metadata.name).toBeLessThanOrEqual(TILE_H);
        }
      }
      cleanup();
    }
  });

  it("still fits a hand-drawn symbol rather than stretching it", () => {
    expect(tileOf("passive.resistor").querySelector("svg.block-tile__art")).not.toBeNull();
    cleanup();
    expect(tileOf("control.transform.clarke").querySelector("svg.block-tile__art")).toBeNull();
  });
});

describe("#213: tile colours come from the theme, never from a literal", () => {
  /** Every paint attribute the tile emits, across the whole catalogue. */
  function paints(name: string): string[] {
    const svg = tileOf(name);
    const out: string[] = [];
    for (const el of svg.querySelectorAll("*")) {
      for (const attr of ["fill", "stroke"]) {
        const value = el.getAttribute(attr);
        if (value !== null) out.push(value);
      }
    }
    cleanup();
    return out;
  }

  it("paints its ink and paper from a variable, never from a literal", () => {
    // A literal is allowed only when it *means* something that no theme gets
    // to override: `boundaryPort` paints its flag in the domain's own wire
    // colour, which is the same signal blue the wire leaving it will take.
    // What is not allowed back is the monochrome pair — a near-black drawing
    // on a white tile is what made the panel a bright hole in a dark window.
    const semantic = new Set(DOMAINS.map(wireColorForDomain));
    const literals: string[] = [];
    for (const metadata of CATALOG) {
      for (const value of paints(metadata.name)) {
        if (value === "none" || value === "transparent") continue;
        if (value.startsWith("var(--")) continue;
        if (semantic.has(value)) continue;
        literals.push(`${metadata.name}: ${value}`);
      }
    }
    expect(literals).toEqual([]);
  });

  it("draws the body of every block from variables", () => {
    for (const metadata of CATALOG) {
      const themed = paints(metadata.name).filter((value) => value.startsWith("var(--"));
      expect(themed.length, `${metadata.name} paints nothing from the theme`).toBeGreaterThan(0);
    }
  });

  it("separates ink from paper so a filled shape can occlude what is behind it", () => {
    const values = new Set(paints("control.sum"));
    const vars = [...values].filter((value) => value.startsWith("var(--"));
    expect(new Set(vars.map((value) => value.split(",")[0])).size).toBeGreaterThan(1);
  });
});
