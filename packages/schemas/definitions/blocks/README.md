# Block metadata schema

This schema is the **shared contract** for how one component is described:
what the front end needs in order to draw it, search it and offer its
parameters, and what the engine has to say about causality, state and ports.

**Who it validates.** The engine owns which components exist — the library is
`crates/gsim-core/data/component-library.json` in `gsim-core` — and
`scripts/gen-engine-catalog.mjs` validates every entry the engine submits
against this schema on its way into `apps/frontend/src/library/engine-catalog.json`.
The engine owns *which* components there are; this owns *what shape* a
component is described in, and validating at that boundary is what makes it a
contract rather than a convention.

The anatomy below is written as YAML because the components used to be a tree
of `metadata.yaml` files in `packages/blocks/`, one per component. That tree is
gone (#162) and the fields are not: an `engine-catalog.json` entry's
`metadata` object is this same shape in JSON. A user-authored component is this
shape too, in a `.gsim_sym` file — see `docs/specs/gsim-symbol-format-spec.md`.

- **Schema:** [`block-metadata.schema.json`](./block-metadata.schema.json)
- **Port-kind subschema:** [`../model/port-kind.schema.json`](../model/port-kind.schema.json)

## File anatomy

```yaml
name:        signal.constant            # <category>.<identifier> — must match path
label:       Constant                   # shown in UI
version:     1                          # schema version (only 1 today)
category:    signal                     # signal | control | power | sinks | subsystems | user
description: Outputs a constant value.  # one-line, for tooltip
aliases:     [const, K]                 # fuzzy-search boost
tags:        [source, signal]           # filtering hints

ports:
  inputs: []
  outputs:
    - { id: out, label: "", kind: { domain: signal, dims: scalar }, side: right, offset: 20 }
  # optional:
  # variadic_inputs:
  #   count_from: signs           # param controlling input count
  #   template: { id: in, label: "", kind: ..., side: left, offset: 0 }

params:
  - name: value
    label: Value
    type: number             # number | integer | vector | matrix | string | bool | enum
    default: 1.0
    description: The constant output value.

symbol:
  bbox: [60, 40]             # integer [width, height] in canvas units
  shape: rect                # rect | circle | triangle | custom
  text: "{value}"            # {paramName} interpolation supported
  # path: "M 0 0 ..."        # required when shape == custom

behavior:
  causality:         source              # source | causal | acausal | sink
  domain:            signal              # signal | electrical | thermal | mechanical | event | mixed
  state_count:       0                   # integer ≥ 0, or "dynamic"
  equation_template: signal.constant     # resolved by the engine

main_param: value          # optional — the Alt+Enter target
```

## Field stability

`name`, port `id`s, and param `name`s are **persisted in every saved model**.
Renaming any of them is a breaking change to every `.gsim` file on disk.
Treat these as a public API:

- Add new ports / params freely (with safe defaults).
- Mark old ones deprecated, but keep them serializable, until a major version.
- Never silently re-purpose an existing identifier.

## Coordinate convention

- Port `side` selects an edge of the bbox in the **unrotated, unmirrored**
  block. The renderer applies rotation and mirror transforms at draw time;
  the metadata stays canonical.
- `offset` is the distance along that side from the top-left corner of the
  bbox: for `side: left|right` it is measured top → bottom; for
  `side: top|bottom`, left → right.
- A block with `bbox: [60, 40]` and a single output on the right side at
  `offset: 20` has its port at the geometric middle of the right edge,
  rendered as a 4 px circle at local coord `(60, 20)`.

## How the simulator uses this file

The frontend stops at `symbol`, `ports`, `params`, search hints, and
`main_param`. The engine's lowering stage reads:

- `behavior.causality` — to validate port directionality during IR-1
  topology construction.
- `behavior.domain` — to dispatch which KCL/KVL/bond-graph constraint set
  applies at the block's nets.
- `behavior.state_count` — to allocate state variables in IR-2.
- `behavior.equation_template` — to look up the Python symbolic template
  that emits IR-2 equations during lowering.

The `params` field is shared: the frontend uses it for editors; the
simulator passes the param dict into the equation template.

## Validation chain

1. `scripts/gen-engine-catalog.mjs` validates every component the engine
   submits against this schema before writing it, and names the offending
   component and JSON pointer when one fails. A malformed component used to
   flow through untouched and be discovered as a blank symbol or a missing
   port on somebody's sheet.
2. Cross-field rules not expressible in pure JSON Schema (e.g.
   `default` must match `type`; `main_param` must exist in `params`) are
   enforced by the loader in `apps/frontend/src/library/catalog-core.ts` and
   tested separately.
3. The generated catalogue is checked into Git
   (`apps/frontend/src/library/engine-catalog.json`), and the
   `engine-catalogue-drift` CI job regenerates it from the engine and fails if
   the committed copy has drifted.

## Adding a component

Not here, and not by hand. A component is declared in the engine; this
repository mirrors the engine's answer and draws it. `docs/DEVELOPMENT.md` §7
is the procedure, and `apps/frontend/src/library/engine-catalog.json` is
generated — editing it is drift, which the CI job above will say so about.
