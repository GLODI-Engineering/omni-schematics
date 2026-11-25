# `@gensim/waveform-wasm`

`crates/waveform-store`, built to WebAssembly with `wasm-pack --target web`.

This is the decimator and the `.gsim_samples` reader, in the one place the
viewer can reach them. Everything under `pkg/` is **generated and committed**;
nothing here is edited by hand.

## What it exports

| export | what it is for |
|---|---|
| `minmaxEnvelope(time, columns, columnCount, maxPoints)` | reduce samples already in the page to a point budget, peak-preserving |
| `SamplesFile` | a `.gsim_samples` container, read through ranges somebody else fetches |
| `FetchedRanges` | those ranges, on their way back in |
| `WaveformStore` | a `.gsim_sim_result` whose samples are inline |

## Why the bundle is committed

The same trade `packages/gsim-wasm` makes, for the same reason: the
alternative is a Rust toolchain plus `wasm-pack` on the way to every
`pnpm --filter @gensim/frontend build`, in three CI jobs, in a contributor's
first checkout, and in the watch loop of anyone editing a React component.
`scripts/build-waveform-wasm.mjs` explains it at length.

The risk a committed artefact carries is that it stops matching its source.
For this one that would mean the viewer drawing a window with a *different*
decimator from the one `cargo test` checks — which is the two-implementations
problem #157 exists to end. So:

* `node scripts/build-waveform-wasm.mjs` rebuilds it and rewrites
  `provenance.json`;
* `node scripts/check-waveform-wasm-fresh.mjs --check` fails if the bundle's
  files do not hash to what `provenance.json` records, if an export went
  missing, or if **anything in `crates/waveform-store` changed** since the
  build. The crate is in this repository, so that question is answered exactly
  and offline, rather than by asking a remote branch where its HEAD is.
* CI runs it as `waveform-wasm-drift`, and the `frontend` job runs every
  assertion about reduction *through this bundle* — `src/test-setup.ts` loads
  it — so a bundle that reduces differently from the crate fails there.

## Where it is loaded

`apps/frontend/src/waveform/decimator.ts` is the only module that
instantiates it. The `.wasm` rides into the `.vsix` as an ordinary Vite asset,
fetched from the extension's own `vscode-webview-resource:` origin, which the
webview CSP's `connect-src` already allows. Instantiating it needs
`'wasm-unsafe-eval'` in `script-src` — see
`apps/vscode-extension/src/webview-html.ts`, which is already there for the
engine.

The extension host does **not** load it. `vsce package --no-dependencies`
ships no `node_modules`, so a value import of a workspace package from the
host resolves on a developer's machine and throws `Cannot find module`
everywhere else. That is decided on #175, and it is the reason the host fetches
byte ranges while the webview does the arithmetic.
