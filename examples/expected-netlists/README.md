# What these files are

The netlist each example compiles to, and the notes the compiler emits with it,
held to the byte by `scripts/check-examples.mjs`.

## Where they came from

They were captured from the path the product took **before** #158 moved the
compiler into the editor: `simulator.compiler.gsim_py_netlist`'s
`compile_gsim_document_full`, as it stood on `main`, against a `gsim_py` built
from `gsim-core` 0.6.0 (`f658437`) — the same commit
`packages/gsim-wasm/provenance.json` names.

That is the point of them. "Every example compiles to the same netlist as
today" is a claim about two different programs agreeing, and it can only be
checked by recording what one of them produced before the other replaced it.
`check-examples.mjs` now compiles with `gsim-core` in WebAssembly and compares
against these files, so the Python compiler's last output is what the
WebAssembly one is measured against. All five matched on the first run,
netlists and notes alike.

## Changing one

A change here is a change in what a circuit means, so it is never a quiet
update. Regenerate with:

```sh
node scripts/check-examples.mjs          # reports the first differing line
```

and, if the new output is right, write it:

```sh
node -e '
  const { loadEngine, compileDocument } = await import("./packages/gsim-wasm/node.js");
  const engine = await loadEngine();
  const { netlist, notes } = compileDocument(engine,
    require("node:fs").readFileSync("examples/<name>.gsim_sch", "utf8"));
  require("node:fs").writeFileSync("examples/expected-netlists/<name>.net", netlist);
  require("node:fs").writeFileSync("examples/expected-netlists/<name>.notes.txt",
    notes.map((n) => n + "\n").join(""));
'
```

The commit that does it should say why the netlist changed. An engine upgrade
that legitimately changes output will change these files; so will a bug, and
the two look identical in a diff without a sentence explaining which it is.

## Notes files

One note per line, in the order the compiler emits them; empty when there are
none. A note is a decision the compiler made *for* the user rather than an
error — most often a DC reference added for a node nothing else ties down. That
does not fail a solve, it changes its answer, which is exactly why a note
appearing or disappearing has to fail a gate.

## Not bundled

`scripts/bundle-examples.mjs` copies only `*.gsim_sch` into the `.vsix`, so
nothing here ships to a user.
