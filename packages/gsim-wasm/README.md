# @gensim/gsim-wasm

`gsim-core`'s own `crates/gsim-wasm`, built to WebAssembly. The compiler the
editor runs.

## Why this package exists

The engine is one Rust implementation of what a `.gsim_sch` document means:
what each block compiles to, how an expression evaluates, how a Goto resolves,
what netlist comes out. Until #158 the editor did not use it. It posted the
whole document to a Python kernel, which compiled it with about 1,600 lines
that reimplemented those same questions in a second language:

| what it reimplemented | lines | the Rust that already existed |
| --- | --- | --- |
| `compiler/param_expression.py` | 261 | `expr/lexer.rs` + `parser.rs` + `eval.rs` |
| `compiler/goto_from_resolve.py` | 295 | `compile/routing.rs` |
| `compiler/gsim_sch_flatten.py` | 401 | `document/subckt.rs` |
| `compiler/gsim_sch_loader.py` + `gsim_sch_writer.py` | 367 | `load_document` / `save_document` |
| `gsim-model/` document, block, connectivity, subckt | ~700 | `document/*` |

Two implementations of one thing drift, and these did — twice that anyone
noticed. #143: a port respelling on the product's side of the compile turned
every example into `floating-port` at Run time while the gate reported five
examples OK. #153: a release gate and the install instructions named two
different engine versions, so a green release could ship wheels that worked on
nobody's machine.

A VS Code extension is a Node process and a webview, and Rust compiled to
WebAssembly runs in both. So the editor reaches the engine with no process in
between, and the compile the editor performs is the compile `gsim_tools`
performs — the same function, not an agreeing copy of it.

## What is in here

| file | what it is |
| --- | --- |
| `pkg/` | `wasm-pack --target web --release` output. **Generated and committed.** |
| `provenance.json` | the engine commit, crate version, exported names and a SHA-256 of every file in `pkg/`. Generated. |
| `compile.js` | the one route from a document to a netlist, shared by the webview, the gates and the release workflow. |
| `node.js` | the loader for a Node process: reads the `.wasm` and hands over the bytes. |

`compile.js` is plain JavaScript on purpose. Three callers have to take the
same route through the engine and they do not share a build — the webview
(bundled by Vite), `scripts/check-examples.mjs` (a bare Node script), and the
release workflow. TypeScript would exclude two of them; a copy in each would
reintroduce #143.

## Size

The `.wasm` is about **1.76 MB** (1,763 KiB), 565 KB gzipped. It ships inside
the `.vsix` and the webview fetches it from the extension's own
`vscode-webview-resource:` origin — local disk, not a network — on the first
Run of a session, lazily, so opening a sheet does not pay for it.

Most of that is the component catalogue: 143 component types with their
parameters, defaults and symbol geometry, plus `serde_json`. The build sets
`opt-level = "s"`, LTO and one codegen unit, which takes it from 2.70 MB to
1.76 MB; `wasm-opt -Oz` on top of that saves a further 0.7%, which is not worth
a second optimiser pass in the build. `panic = "abort"` is deliberately *not*
set — the engine's contract is that a caller sees a real JS `Error` carrying
the compiler's own message, and aborting throws that message away for a few KB.

## Building and keeping it fresh

```sh
node scripts/build-gsim-wasm.mjs                        # from the engine's default branch
node scripts/build-gsim-wasm.mjs --rev <sha>            # from one commit
node scripts/build-gsim-wasm.mjs --source ../gsim-core  # from a local checkout
```

Needs `wasm-pack` 0.13.1 and a Rust toolchain. Commit `pkg/` and
`provenance.json` together, in a commit that says why the engine moved.

The bundle is committed rather than built on demand because the alternative is
a Rust toolchain plus `wasm-pack` on the way to every `pnpm --filter
@gensim/frontend build`: the `frontend` job, the `vscode-extension` job, the
`e2e` job, a contributor's first checkout, and the watch loop of anyone editing
a React component. The engine changes a few times a month; the frontend is
built hundreds of times a day.

That trade carries a risk, and the risk here is the worst available — the
editor compiling with a *fork* of the engine, silently, which is the
two-implementations problem #158 removed, wearing a different hat. So:

```sh
node scripts/check-gsim-wasm-fresh.mjs --check --against-engine
```

Three arms: the bundle hashes to what `provenance.json` records and exports
what its own `.d.ts` declares; the commit it names is the engine's
default-branch HEAD (the same question `engine-catalogue-drift` asks of the
catalogue); and the exported names are the `#[wasm_bindgen]` items the engine
declares at that commit. CI runs it, then rebuilds from the pinned commit and
compiles every example with the result — identical netlists from both bundles
is a stronger statement than identical bytes, and unlike bytes it does not
depend on the Rust, `wasm-bindgen` and `wasm-opt` versions all matching.

## The 19 functions

The engine exports the same 19 as `gsim-py`, so a front end and a Python caller
perform the same operations against the same JSON shapes:

`version`, `capabilities`, `catalog`, `evaluateComponent`, `validateParameters`,
`newModel`, `addBlock`, `addSubcktDef`, `instantiateSubckt`, `compile`,
`removeBlock`, `setParam`, `addModelParam`, `connect`, `autoArrange`,
`loadDocument`, `saveDocument`, `placeWithoutOverlap`, `layeredLayout`.

`compile` is the one the editor cannot work without, and
`check-gsim-wasm-fresh.mjs` names it specifically so a build that dropped it
fails with that word rather than with a count.

## Using it

In the webview, through `apps/frontend/src/engine/engine.ts`, which owns the
instantiation and the CSP requirement (`'wasm-unsafe-eval'`, the narrow
directive that permits WebAssembly and not `eval`). In a Node process:

```js
import { loadEngine, compileDocument } from "@gensim/gsim-wasm/node";

const engine = await loadEngine();
const { netlist, notes } = compileDocument(engine, documentText);
```

`notes` are decisions the compiler made *for* the caller rather than errors —
most often a DC reference added for a node nothing else ties down. Show them:
an unreferenced node does not fail a solve, it returns a different answer.
