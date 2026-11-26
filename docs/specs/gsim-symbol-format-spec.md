# GSF — Gsim Symbol Format (v1)

> **Status:** the `.gsim_sym` file format is live and this document is its
> authority. The Python authoring API of §4 was never built and is withdrawn
> — see the note on it.
> **Depends on:** the catalog-driven primitive renderer — GSF's primitive
> vocabulary is defined as *exactly* the `Primitive` union in
> `apps/frontend/src/canvas/nodes/primitive-renderer.ts`, not a new one.
> **Implemented by:** `apps/vscode-extension/src/symbolLibrary.ts`, which
> writes one `.gsim/symbols/<name>.gsim_sym` per user-authored component in
> the workspace folder, and the `symbol.primitives` extension in
> `packages/schemas/definitions/blocks/block-metadata.schema.json`.
> **Supersedes nothing:** the deferred in-canvas drawing UI still governs that
> future; this document is the data format it will target.

## 1. Why a new format, and why it isn't a new runtime store

The deferred symbol-editor design already forbids a parallel persistence store
for catalog symbols, and GSF does not add one. The catalog's source of truth
is the engine's component library — `gsim-core`'s
`crates/gsim-core/data/component-library.json` — mirrored into
`apps/frontend/src/library/engine-catalog.json` by
`scripts/gen-engine-catalog.mjs` and held to it by the
`engine-catalogue-drift` CI job. When this document was written that source
was a tree of `metadata.yaml` files in this repository compiled into a
`catalog-manifest.json`; both are gone, and "the catalog entry" below means an
entry of that generated mirror.

GSF is two things, both additive:

1. **A schema extension**: `symbol.shape: primitives` — a new alternative to
   the existing `rect | circle | triangle | custom` enum
   (`packages/schemas/definitions/blocks/block-metadata.schema.json:164`).
   When set, `symbol.primitives` holds a literal array of `Primitive` union
   values (§2) instead of relying on the built-in single-shape renderer. This
   is what lets a real multi-primitive drawing (a BJT, a MOSFET) live in
   `metadata.yaml` and be read by `metadataToPrimitives()`, instead of
   requiring a hand-written entry in `component-symbols.tsx`'s
   `SCHEMATIC_SYMBOLS` table.
2. **A portable single-component file, `.gsim_sym`**: the JSON serialization
   of one component definition (a superset of a catalog entry: it adds a
   top-level `name`/`type` wrapper so the file is self-describing without a
   catalog path). It exists for *authoring and exchange* — build a component,
   validate it, preview it, share it, keep it in the project's own version
   control. This is the part that shipped:
   `apps/vscode-extension/src/symbolLibrary.ts` writes one per component under
   `.gsim/symbols/` in the workspace folder, and the library panel reads them
   back. A bridge named `gsim_model.gsim_sym.merge_into_catalog()` was
   specified here as the only route from such a file into the catalog; it was
   never built, it was deleted with the Python workspace (#162), and a
   `.gsim_sym` is read today by the extension rather than merged into the
   engine's library at all.

## 2. Primitive vocabulary (frozen, matches the renderer exactly)

```
line · rect · rectf · circle · arc · polygon · polyline · text
```

Field-for-field identical to the TypeScript union at
`primitive-renderer.ts`'s `Primitive`. No new primitive kinds. Coordinates are
integers in block-local space, origin at the top-left of `symbol.bbox` — the
same frame `metadataToPrimitives()` in that file already uses. (Line numbers
stood here and have been removed: they were four edits out of date, and a
reference that drifts silently is worse than a name you have to grep for.)

## 3. Transforms are an authoring-time convenience, not a schema field

The rendered/stored `Primitive` values stay in absolute coordinates — the
runtime schema and `renderPrimitives()` do not change shape. Transforms
(`translate`, `rotate`, `scale`, `mirror`) live only in the Python authoring
API (`gsim_model.symbol`, §4): each transform method takes a primitive and
returns a **new primitive with the transform already baked into its
coordinates**. This keeps the frontend renderer untouched (zero new render
logic — `renderPrimitives()` already handles the full union) and keeps GSF
files simple, portable data with no transform-evaluation step required of
whoever reads them.

## 4. Python component-creator API (`gsim_model.symbol`) — withdrawn, never built

> **Nothing below exists.** `gsim_model` was a Python package in this
> repository and was deleted with the rest of the Python workspace (#162)
> without this API ever being written. It is kept here as the record of a
> design decision — that transforms resolve at authoring time so that readers
> and the renderer stay free of them, which §3 states and which is still the
> rule — and not as a thing to call. Anything authoring a `.gsim_sym`
> programmatically today writes the JSON of §1.2 directly.

- Primitive builder functions/dataclasses for all eight kinds.
- Transform methods, composable by chaining, each returning a new resolved
  primitive: `.translate(dx, dy)`, `.rotate(degrees, center=None)`,
  `.scale(sx, sy=None, center=None)`, `.mirror(axis)`.
- `SymbolBuilder`: accumulates primitives + a bbox, exposes `.port(id, side,
  offset, kind, direction)` for port placement (reusing the existing
  `side`/`offset` convention from `gsim_model.layout.PortGeometry` — no new
  port-positioning scheme), and `.build()` producing a GSF-shaped `symbol` +
  `ports` fragment.
- `ComponentDefinition`: the full authoring object — `name`, `label`,
  `version`, `category`, `description`, `paradigm` (one of the existing
  paradigm enum values: physical-network | signal-flow | converter |
  hierarchy | routing | annotation | spice-subckt — exactly one, required),
  `domain`, `aliases`, `tags`, `params`, `fidelities`, `symbol`
  (`SymbolBuilder.build()` output), `ports`, `behavior`. Raises `ValueError`
  if `paradigm` is missing or not from the enum — "every component is of
  exactly one type" is enforced here, not left to convention.

## 5. Explicit non-goals

- No drag-and-drop / canvas drawing UI. Deferred.
- No change to `renderPrimitives()`, `symbolTransform()`, or port hit-testing
  math — GSF reuses all of it unmodified.
- No migration of the hand-written drawings. Parity for a BJT and a MOSFET was
  proved as a validation exercise (`bjt-mosfet-symbol-parity.test.ts`);
  retiring the hand-written artwork under
  `apps/frontend/src/canvas/nodes/symbols/` component by component would be a
  separate piece of work and is not planned.
