---
name: import-symbol
description: Import a user-drawn draw.io SVG component symbol into the editor — extract geometry, read the box and ports the engine catalogue declares, compute the coordinate transform, write the drawing under canvas/nodes/symbols/, register it, verify, commit.
---

# `/import-symbol` — Import a draw.io SVG symbol into the frontend

Invoke whenever the user hands you one or more `.drawio.svg` files and asks
you to "import" them. The process has seven deterministic steps. Do not skip
any.

**A drawing is not the component.** What a component *is* — its ports, their
sides and offsets, its box, its parameters, what it compiles to — is declared
by the engine's component library and reaches the editor through the generated
`apps/frontend/src/library/engine-catalog.json`. An import changes only how it
looks, and that lives in exactly two files (Steps 5 and 6).

---

## Convention the user follows when drawing

- The drawing canvas in draw.io has **no fixed size** — the user draws at
  whatever scale feels comfortable.
- **Red lines (`#FF2A00` stroke)** are **port stubs** — short segments
  that extend from the component body to the external pin connection
  point. The OUTER tip of each red stub is the pin's wire-connection
  point. The INNER end (where red meets black) is the component boundary.
- **Black lines** are the component body.
- **Labels** (D, G, S, B, C, E …) are placed near each red stub to name
  the port.

---

## Step 1 — Scan the drawing file(s)

Run the extraction script below for every new SVG file. It prints all SVG
elements, their color, and the bounding box.

```python
import xml.etree.ElementTree as ET, re

def parse_d(d):
    return [(float(p.split()[0]), float(p.split()[1]))
            for p in re.findall(r'[-\d.]+\s+[-\d.]+', d)]

fname = "<path>/<file>.drawio.svg"   # wherever the user put it
tree = ET.parse(fname)
root = tree.getroot()
print(f"SVG: {root.get('width')} x {root.get('height')}")

all_pts = []
for p in root.iter('{http://www.w3.org/2000/svg}path'):
    d = p.get('d','')
    style = p.get('style','') or ''; stroke = p.get('stroke','') or ''
    sw = p.get('stroke-width','?')
    is_red = 'ff2a00' in stroke.lower() or 'ff2a00' in style.lower() \
             or 'rgb(255, 42, 0)' in style
    color = 'RED' if is_red else 'black'
    pts = parse_d(d)
    if pts:
        print(f'  [{color} sw={sw}] {pts[0]} → {pts[-1]}  d="{d[:70]}"')
        all_pts.extend(pts)

for e in root.iter('{http://www.w3.org/2000/svg}ellipse'):
    cx,cy = float(e.get('cx',0)), float(e.get('cy',0))
    rx,ry = float(e.get('rx',0)), float(e.get('ry',0))
    print(f'  [ellipse] cx={cx} cy={cy} rx={rx} ry={ry}')
    all_pts += [(cx-rx,cy),(cx+rx,cy),(cx,cy-ry),(cx,cy+ry)]

xs=[p[0] for p in all_pts]; ys=[p[1] for p in all_pts]
print(f'bbox: x={min(xs):.0f}→{max(xs):.0f}  y={min(ys):.0f}→{max(ys):.0f}')

print('\nPORT STUBS (RED):')
for p in root.iter('{http://www.w3.org/2000/svg}path'):
    style=p.get('style','') or ''; stroke=p.get('stroke','') or ''
    if 'ff2a00' in stroke.lower() or 'ff2a00' in style.lower() \
       or 'rgb(255, 42, 0)' in style:
        pts=parse_d(p.get('d',''))
        if pts: print(f'  outer={pts[0]}  inner={pts[-1]}')
```

**From the output, record:**

| Variable | Value |
|---|---|
| `x0, x1` | x range of **black** elements only (strip red stubs and labels) |
| `y0, y1` | y range of **black** elements only |
| `bw = x1 - x0` | body width in draw.io units |
| `bh = y1 - y0` | body height in draw.io units |
| For each port: `(px, py)` | INNER end of the red stub (body boundary) |
| For each port: exit direction | Which face the red stub exits from |

---

## Step 2 — Read the box and the port layout; do not choose them

**The catalogue decides the geometry, and the drawing obeys it.** A
component's bounding box and the side and offset of every port are declared by
the engine's component library (`gsim-core`'s `data/component-library.json`),
mirrored into `apps/frontend/src/library/engine-catalog.json` by
`scripts/gen-engine-catalog.mjs`. The mirror is generated and checked by the
`engine-catalogue-drift` job — editing it by hand is drift, not an import.

So read the target, rather than picking one:

```bash
node -e '
const name = process.argv[1];
const entry = require("./apps/frontend/src/library/engine-catalog.json")
  .find((e) => e.metadata.name === name || (e.metadata.aliases ?? []).includes(name));
if (!entry) throw new Error(`no catalog entry for ${name}`);
const fid = entry.metadata.fidelities?.[0] ?? {};
console.log("bbox  ", JSON.stringify(entry.metadata.symbol?.bbox));
console.log("ports ", JSON.stringify(fid.ports ?? entry.metadata.ports, null, 1));
' passive.resistor
```

`W × H` is that bbox, in unscaled local units, and the ports are at those
sides and offsets whether the drawing likes it or not. The drawing is handed
the box as `ctx.width`/`ctx.height` and must stay inside it and touch every
terminal the entry declares.

If the box is genuinely the wrong shape for the part, that is a change to the
engine's component library and belongs in `gsim-core` as its own piece of
work. It is not something an import does on the way past.

---

## Step 3 — Compute the coordinate transform

```
svg_x(X) = round((X - x0) / bw * W, 1)
svg_y(Y) = round((Y - y0) / bh * H, 1)
```

This maps draw.io body coordinates to the `[0,W] × [0,H]` SVG bbox space.
Run a second Python snippet that applies this transform to every element
and prints the results. Round each coordinate to the nearest integer for
clean JSX.

---

## Step 4 — Check the ports you were given, do not invent them

Step 2 already told you where every port is. Use the transform to confirm the
drawing's own stubs land on them:

| Port exits via … | `side` | `offset` compared against |
|---|---|---|
| Left face (stub goes left) | `left` | `svg_y(py)` |
| Right face (stub goes right) | `right` | `svg_y(py)` |
| Top face (stub goes up) | `top` | `svg_x(px)` |
| Bottom face (stub goes down) | `bottom` | `svg_x(px)` |

Round to the nearest integer before comparing. A mismatch means the drawing
has to move, because the catalogue entry is not yours to adjust. A drawing
whose ink does not reach a declared terminal renders as a floating symbol with
a wire that ends in mid-air.

---

## Step 5 — Write the drawing

One file per symbol, under `apps/frontend/src/canvas/nodes/symbols/<name>.tsx`,
default-exporting a `SymbolDrawing`. Read `resistor.tsx` or `led.tsx` first;
they are the shape every drawing takes.

```tsx
import type { ReactNode } from "react";

import { type DrawContext, FILL, STROKE, SW, type SymbolDrawing } from "../symbol-drawing";

function draw(_ctx: DrawContext): ReactNode {
  return (
    <g>
      {/* geometry from <filename>.drawio.svg, transformed in Step 3 */}
      <line x1={0} y1={20} x2={20} y2={20} stroke={STROKE} strokeWidth={SW} />
    </g>
  );
}

const drawing: SymbolDrawing = { draw, inkHeight: 24 };
export default drawing;
```

Each SVG element from the draw.io file maps to one JSX element:

| draw.io element | JSX | Notes |
|---|---|---|
| `M x1 y1 L x2 y2` (line) | `<line x1={} y1={} x2={} y2={} stroke={STROKE} strokeWidth={SW} />` | |
| `M … L … L … Z` (closed path / polygon) | `<polygon points="x1,y1 x2,y2 …" fill={STROKE} stroke="none" />` | For filled arrows |
| `M … L … L … Z` (open / unfilled polygon) | `<polyline points="…" fill="none" stroke={STROKE} strokeWidth={SW} />` | |
| Ellipse | `<circle cx={} cy={} r={} fill="none" stroke={STROKE} strokeWidth={SW*0.8} />` | Use `<ellipse>` if rx≠ry by more than 2 |
| Many joined segments | `<polyline points="…" fill="none" stroke={STROKE} strokeWidth={SW} strokeLinecap="round" strokeLinejoin="round" />` | |

`STROKE`, `FILL` and `SW` come from `../symbol-drawing` — import them rather
than writing a colour or a width. `STROKE` is a CSS variable with the canvas's
near-black as its fallback, which is what lets the library panel draw the same
artwork in its own palette; a hard-coded `#0f172a` breaks that. After
`SYMBOL_SCALE` is applied at render time `SW` matches the wire stroke width.

Set `inkHeight` when the artwork does not fill its box, so the name and value
are placed clear of the ink rather than of the box outline. Set
`selfDrawnPorts` only if the drawing draws its own terminal stubs and dots.

If N and P variants share a structure with one visual difference (arrow
direction, say), write one `draw(kind)` helper and two thin wrappers — see
`bjtNpn.tsx` / `bjtPnp.tsx`.

---

## Step 6 — Register it

In `apps/frontend/src/canvas/nodes/symbols/registry.ts`: one import, and one
entry in `SYMBOL_DRAWINGS` per catalogue type the drawing serves.

```tsx
import myPartDrawing from "./myPart";
// …
export const SYMBOL_DRAWINGS: Record<string, SymbolDrawing> = {
  "passive.my_part": myPartDrawing,
  "physical_electrical.passive.my_part": myPartDrawing,  // the namespaced spelling
};
```

The key must be a `metadata.name` or alias that the catalogue actually
carries — a key that matches nothing silently falls back to a plain rectangle.
The catalogue spells most electrical parts both short and namespaced and they
are the same component, so one drawing normally takes several keys. That file
and this directory are the whole seam: nothing about what a component *is*
lives on this side, so swapping artwork cannot change behaviour.

`component-symbols.tsx` holds the older `SCHEMATIC_SYMBOLS` registry, which
`getSchematicSymbol()` still consults. New artwork goes in `symbols/`; do not
add to `SCHEMATIC_SYMBOLS`.

---

## Step 7 — Verify

```bash
pnpm -F @gensim/frontend typecheck
pnpm -F @gensim/frontend test                        # the whole suite
pnpm -F @gensim/frontend exec vitest run src/canvas/nodes/   # just the symbols
```

`a-type-draws-its-own-symbol.test.ts` and `BlockSymbol.test.tsx` are the two
that fail when a registration does not match the catalogue.

Rendering work is visual: render the symbol to a PNG with
`node scripts/render-schematic.mjs` and **look at the image** before claiming
it is right (`CLAUDE.md`).

Then commit with `/commit`:

```
feat(canvas): import user-drawn <ComponentName> symbol
```

The message body should name the source `.drawio.svg`, the catalogue types the
drawing was registered for, and the box it was drawn to.

---

## Quick-reference: file checklist

| File | What changes |
|---|---|
| `apps/frontend/src/canvas/nodes/symbols/<name>.tsx` | The drawing: new file |
| `apps/frontend/src/canvas/nodes/symbols/registry.ts` | One import, one `SYMBOL_DRAWINGS` entry per catalogue type |

No other file changes for a symbol-only import. In particular the catalogue
does not: ports, bbox and parameters are the engine's, and
`engine-catalog.json` is generated.

---

## Common pitfalls

| Problem | Cause | Fix |
|---|---|---|
| Ink does not reach a terminal | The drawing was scaled to its own bounds, not to the catalogue's box | Re-run Step 3 against the bbox from Step 2 |
| Wire appears to leave the wrong face | The drawing was mirrored on import | The catalogue fixes the side; turn the artwork, not the entry |
| Symbol invisible (shows rect fallback) | `SYMBOL_DRAWINGS` key matches no catalogue `name` or alias | Re-run the Step 2 lookup for the exact spelling; check `_` vs `-` |
| Circle distorted | rx ≠ ry after transform | The body bounds have different x and y scales; use `<ellipse rx={} ry={}>` instead of `<circle>` |
| HMR crash "Duplicate … id" | Registry Map not cleared on hot reload | `bootRegistries()` in `App.tsx` must call `resetActivityRegistry()` and `resetBottomTabRegistry()` before registering — already fixed, don't revert |
