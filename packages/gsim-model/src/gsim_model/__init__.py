"""`.gsim_sym` component authoring, in Python.

## What this package is, after #158

It was two things. One of them is gone.

The half that is gone was a Python document model — `GsimSchDocument`, `Model`,
`Block`, `Wire`, `SubcktDef`, `ModelBuilder`, `ConnectivityGraph` — a
hand-written pydantic copy of what `gsim-core` already describes in Rust, kept
in step with `packages/schemas/definitions/model/gsim_sch.schema.json` by a
test. Nothing in this repository imported it. The engine declares the document
(`loadDocument`, `saveDocument`, `newModel`, `addBlock`, `connect`,
`addSubcktDef`, `instantiateSubckt`), the editor reaches that through
`packages/gsim-wasm`, and a second description of a document is exactly the
kind of thing #143 and #153 were.

What is left is the `.gsim_sym` component-creator API that
`docs/specs/gsim-symbol-format-spec.md` §4 specifies: build a symbol out of the
eight primitive kinds, place its ports, write the file. That is not a copy of
anything in the engine — the engine has no symbol authoring — though the
editor's own symbol editor (`apps/frontend/src/symbol-editor/`) does the same
job for a person rather than for a script.

Exported from the modules themselves rather than re-exported here, because
there is no longer a package-level object worth naming: import
`gsim_model.symbol`, `gsim_model.gsim_sym`, `gsim_model.layout` or
`gsim_model.catalog` directly.
"""

__all__: list[str] = []
