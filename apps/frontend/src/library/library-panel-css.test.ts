/**
 * #213 — the panel's own stylesheet, which is where four of the five defects
 * actually lived.
 *
 * jsdom does no layout, so a rendered DOM cannot tell you a row is 56 px tall
 * or that the list scrolls sideways. The declarations can, and they are the
 * things that broke:
 *
 * - `.library-item` was a 56 px tile in a `8px 10px` row, 56 px tall, so a
 *   282 px panel showed nine of 68 entries and the list ran 4 472 px.
 * - `.library-tree__items` was `display: grid` with no `grid-template-columns`,
 *   so the implicit column sized to its widest label and the panel scrolled
 *   horizontally.
 * - `.library-item__label` had no overflow handling, and ten catalogue labels
 *   are over twenty characters ("Inverse Clarke-Park Transform" is 29).
 * - `.library-item` was `background: #ffffff` with no dark counterpart, which
 *   is why the panel was a white island in a dark VS Code.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { TILE_H, TILE_W } from "./BlockTile";

// `import.meta.url` is a vite-dev URL under vitest, not a file one, so the
// stylesheet is found from the package root instead.
const CSS = readFileSync(path.resolve(process.cwd(), "src/styles/app.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Every declaration block of a rule whose selector list names `selector`. */
function blocks(selector: string): string[] {
  const out = libraryRules()
    .filter(([selectors]) =>
      selectors.split(",").some((one) => one.trim().replace(/::?[a-z-]+$/, "") === selector),
    )
    .map(([, body]) => body);
  if (out.length === 0) throw new Error(`app.css has no rule for ${selector}`);
  return out;
}

/** The declaration block of the rule that styles `selector` on its own. */
function rule(selector: string): string {
  return blocks(selector).join(";");
}

/**
 * A custom property's value, wherever in the panel's rules it is declared.
 * The row height is one, so the list's two row types cannot drift apart.
 */
function customProperty(name: string): string | undefined {
  let value: string | undefined;
  for (const [, body] of libraryRules()) {
    const match = body.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`));
    if (match?.[1]) value = match[1].trim();
  }
  return value;
}

/** The last value the stylesheet gives `property` for `selector` — what wins. */
function declaration(selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const body of blocks(selector)) {
    const match = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
    if (match?.[1]) value = match[1].trim();
  }
  if (value === undefined) return undefined;
  const indirect = value.match(/^var\((--[a-z0-9-]+)(?:\s*,\s*([^)]*))?\)$/);
  if (!indirect) return value;
  return customProperty(indirect[1] as string) ?? indirect[2]?.trim();
}

/** Every declaration block in the stylesheet whose selector names a library part. */
function libraryRules(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const pattern = /([^{}]+)\{([^}]*)\}/g;
  let match = pattern.exec(CSS);
  while (match !== null) {
    const selector = (match[1] ?? "").trim();
    if (/\.library-(activity|item|tree|chip)/.test(selector)) {
      out.push([selector, match[2] ?? ""]);
    }
    match = pattern.exec(CSS);
  }
  return out;
}

describe("#213: the library list is dense", () => {
  it("caps the row height at a third of what it was", () => {
    const minHeight = declaration(".library-item", "min-height");
    expect(minHeight, ".library-item must declare the row height it promises").toBeDefined();
    expect(Number.parseFloat(minHeight ?? "")).toBeLessThanOrEqual(26);
  });

  it("sizes the preview to the tile the tile component draws", () => {
    expect(declaration(".library-item__preview", "width")).toBe(`${TILE_W}px`);
    expect(declaration(".library-item__preview", "height")).toBe(`${TILE_H}px`);
    expect(TILE_H).toBeLessThanOrEqual(26);
  });

  it("gives the group header a list-row's worth of space, not a card's", () => {
    const padding = declaration(".library-tree__toggle", "padding");
    expect(padding).toBeDefined();
    expect(Number.parseFloat(padding ?? "")).toBeLessThanOrEqual(4);
  });
});

describe("#213: the list does not scroll sideways", () => {
  it("pins the grid to one column that cannot outgrow the panel", () => {
    const columns = declaration(".library-tree__items", "grid-template-columns");
    expect(
      columns,
      ".library-tree__items is a grid; without a template its column sizes to its widest label",
    ).toBeDefined();
    expect(columns).toContain("minmax(0");
  });

  it("truncates a label too long for the panel instead of widening it", () => {
    expect(declaration(".library-item__label", "overflow")).toBe("hidden");
    expect(declaration(".library-item__label", "text-overflow")).toBe("ellipsis");
    expect(declaration(".library-item__label", "white-space")).toBe("nowrap");
  });
});

describe("#213: the panel follows the VS Code theme", () => {
  it("takes its surface and text from the host, in both themes at once", () => {
    const body = rule(".library-activity");
    for (const property of ["background", "color"]) {
      const value = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1];
      expect(value, `.library-activity must declare ${property}`).toBeDefined();
      expect(value).toContain("var(--vscode-");
    }
  });

  it("hands the symbol artwork a theme ink and a theme paper", () => {
    // `symbol-drawing.tsx` paints with `var(--schematic-ink)` /
    // `var(--schematic-paper)`; undefined, those fall back to the canvas's own
    // near-black on white, which is exactly the white island this fixes.
    const body = rule(".library-activity");
    expect(body).toContain("--schematic-ink:");
    expect(body).toContain("--schematic-paper:");
    expect(body.match(/--schematic-ink:[^;]*/)?.[0]).toContain("var(--vscode-");
    expect(body.match(/--schematic-paper:[^;]*/)?.[0]).toContain("var(--vscode-");
  });

  it("names no colour of its own anywhere in the panel", () => {
    const literals: string[] = [];
    for (const [selector, body] of libraryRules()) {
      for (const line of body.split(";")) {
        const [property, ...rest] = line.split(":");
        if (!property || rest.length === 0) continue;
        if (
          !/^\s*(background|background-color|color|border|border-\w+|fill|stroke|outline)\s*$/.test(
            property,
          )
        ) {
          continue;
        }
        const value = rest.join(":");
        if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(value) && !value.includes("var(--vscode-")) {
          literals.push(`${selector} { ${property.trim()}: ${value.trim()} }`);
        }
      }
    }
    expect(literals).toEqual([]);
  });
});
