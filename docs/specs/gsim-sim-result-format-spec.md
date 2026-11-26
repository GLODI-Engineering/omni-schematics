# `.gsim_sim_result` — the simulation result format (v2)

> **Status:** v2, implemented.
> **Schema:** `packages/schemas/definitions/results/gsim_sim_result.schema.json`
> (the source of truth — AGENTS.md puts cross-language schemas there).
> **Reader:** `apps/frontend/src/results/`.
> **Writer, for a run:** `apps/vscode-extension/src/result-manifest.ts`.
> **Writer, for an export:** `apps/frontend/src/waveform/export-data.ts`.
> **Editor:** `apps/vscode-extension/src/resultsEditor.ts`.

## 1. Why the format exists

A simulation result used to be visible only while the session that produced
it was still alive. A Python post-processor wrote each run to
`<workdir>/results/<sim_id>/` as a directory of `.npy` files and the sidecar
put that workdir under `$XDG_DATA_HOME` — an app-private cache outside the
workspace, keyed by an in-memory id, reachable only through a running
process. Both that writer and that process are gone (#162), but the problem
they created is the reason this format exists and is worth stating: a result
could not be committed, attached to a review, reopened next week, or compared
against one from another branch. `waveformPanel.ts` said as much, and called
the fix by name:

> If a persisted single-file results bundle is ever added, registering a
> second Custom Editor for *that* becomes the right call.

This is that bundle. A file in the workspace that opens by double-clicking it
and needs no process of its own.

## 2. Shape

A run's result is two files: this document, and the `.gsim_samples` container
beside it that holds the numbers. An exported one can be a single file that
carries its own samples. `data.kind` says which arrangement a given file uses,
and it is the only field a reader must look at before anything else.

```json
{
  "schema_version": 2,
  "data":    { "kind": "samples", "path": "run.gsim_samples", "pyramid": true },
  "run":     { "id": "…", "analysis": "TRAN", "source": "buck.gsim_sch", "created": "…" },
  "sweep":   { "name": "time", "unit": "s", "domain": "time", "encoding": "f64-base64", "data": "…" },
  "signals": [ { "name": "V(out)", "unit": "V", "quantity": "voltage", "encoding": "f64-base64", "data": "…" } ],
  "layout":  { "figures": [ … ] }
}
```

| Field | Required | Notes |
|---|---|---|
| `schema_version` | yes | Must be `2`. A reader rejects anything else rather than guessing. A v1 document — samples always inline, no `data` — is upgraded to this shape before validation, so files already written stay readable. |
| `data` | yes | Where the samples are: `inline` (in this file), `samples` (the `.gsim_samples` container at `path`), or `hdf5`. `path` is relative to this file's directory, so a result and its data move together. |
| `run` | yes | Where it came from. `analysis` is `TRAN`/`AC`/`DC`/…; `source` is the workspace-relative `.gsim_sch`. |
| `sweep` | yes | The shared x axis. `domain` decides the axis name and whether it is logarithmic. |
| `signals` | yes | Each sampled at `sweep`, in the same order. `quantity` groups signals onto a shared y-axis. |
| `layout` | no | How the viewer had them arranged. Without it, the reader puts one axes per quantity. |

### Why one axes per quantity by default

Autoscaling a 48 V trace together with a 2 A one flattens the current to a
straight line. "Everything on one axes" is the wrong default the moment a
result holds two quantities, and a file written by a script usually carries
no layout.

## 3. Sample encoding, when the samples are inline

With `data.kind: "samples"` the numbers are in the container and the fields
below do not appear: the container has its own layout and its own LOD pyramid,
and `crates/waveform-store` reads windows out of it. What follows is the
`inline` arrangement, which is what an export from the viewer writes.

`encoding` is `f64-base64` or `json`.

`f64-base64` is base64 of little-endian IEEE-754 doubles. Two reasons, and
the first is the important one:

- **Exactness.** A round trip is the identity, bit for bit. A result that
  does not come back exactly cannot be used to check an engine against a
  reference — the disagreement being measured is routinely smaller than the
  error a decimal round trip introduces. A SOGI-PLL run cross-checked
  against an independent C implementation agreed to $3.8 \times 10^{-14}$
  relative; a result file that rounded to six figures would have destroyed
  that measurement before it could be made.
- **Size.** A double costs $64/6 \approx 10.67$ base64 characters against
  roughly 20 for decimal text.

`json` is a plain array of numbers, for a result short enough that someone
would read or diff it. The writer picks `json` at or below
`READABLE_SAMPLE_LIMIT` (256) samples and `f64-base64` above it; readers
accept both, per vector.

## 4. The invariant JSON Schema cannot state

In an `inline` document, every signal must have exactly as many samples as
`sweep`. The schema
cannot express a cross-field length equality, so `parseGsimSimResult`
checks it and names the offending signal.

This one has to fail loudly, because downstream it is invisible: a signal
one sample short is not an error to the chart, it simply plots every $y$
against the wrong $x$.

## 5. Why the editor is read-only

A `.gsim_sim_result` is derived data — the schematic and its analysis are
the source. There is no edit to make and nothing to save, so
`ResultsEditorProvider` never fires `onDidChangeCustomDocument` and VS Code
leaves the tab permanently clean: no phantom dirty dot, and no Ctrl+S that
silently rewrites a measurement. Changing a result means re-running the
simulation and exporting again, which is the only way the file and the model
it came from stay honest.

The provider does watch the file: a result is usually rewritten by something
other than this editor — a re-run, a script, a branch switch — and a stale
plot of a file that no longer says that is worse than a reload.

## 6. Producing one

From the viewer: **Export** on an axes or **Export figure** on a figure,
then pick *Result file*. The same dialog writes CSV, PNG, JPEG, SVG and PDF
— see `apps/frontend/src/waveform/export-data.ts` for why both a picture
and the numbers are offered.

CSV is the other half of that pair and is deliberately lossy: one column per
signal against the sweep, opens anywhere, and drops the units and the last
bits. Use it to cross-check; use `.gsim_sim_result` to keep.

## 7. Not done yet

- **Several sweeps in one file.** A corner sweep or a Monte Carlo run is a
  family of results sharing a schematic. v2 holds one.
- **Compression** of an `inline` document. A 25,000-step, 11-signal run is
  about 2.9 MB. Gzip would roughly halve that, at the cost of a file no
  longer readable with `jq`. A run does not have this problem: its manifest
  is a few hundred bytes whatever the run's length.
- **A writer outside this repository.** The two writers named at the top are
  both here, so nothing else produces the format yet. The schema sits in
  `packages/schemas/definitions/` so that a third one has a single contract
  to target rather than inventing a second.
