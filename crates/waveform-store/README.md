# gs-waveform-store

Reads a `.gsim_sim_result` and serves decimated windows of its signals.

One implementation, compiled natively for the server and to WebAssembly for
the viewer, so both answer the same question the same way: *give me this
window of these signals, in at most this many points.*

## Why it exists

There were three implementations of that reduction — two in Python
(`postprocess/decimation.py`, write-time pyramid and query-time fallback)
and one in TypeScript (`axes-config.ts`) — so a trace could change shape
depending on which produced it, and a difference between the browser's view
and the server's was indistinguishable from a bug in the simulation.

There is one now, and it is this (#157). The TypeScript copy and both Python
ones are deleted; the viewer calls this crate directly, built to WebAssembly
and committed in `packages/waveform-wasm`, and the frontend's whole test
suite runs its reduction assertions through that bundle. There is no Python
decimation left at all: the last copy was private to the legacy HDF5 writer
`hdf5_store.py`, and #156 deleted both.

It also makes a hosted deployment affordable. A plot 1500 px wide can
distinguish about 3000 points: two per pixel, one for the top of each column
and one for the bottom. Everything past that is paid for and not seen. On a
measured 11-signal, 250,000-sample run that is 32 MB moved and held, against
roughly 260 KB for the same picture.

## Measured, on a real run

An 11-signal, 25,000-sample SOGI-PLL result (3.2 MB on disk):

| | |
|---|---|
| parse the whole document | 19 ms |
| full extent at 2,728 points | 1.1 ms |
| a 2% window, exact (2,002 points) | 0.3 ms |

The `.wasm` is 137 KB.

## What survives decimation

`tests/properties.rs` establishes this on waveforms shaped like a converter's,
because it decides what the viewer is allowed to report:

| measurement | under min/max envelope |
|---|---|
| max, min | **exact**, at every budget |
| peak-to-peak | **exact** |
| every sample inside the drawn band | **guaranteed** |
| mean | within 0.03% while buckets stay finer than the waveform's period; structurally wrong once they span many |
| RMS | biased high, for the same reason |

The reduction is a min/max **envelope** on a shared time grid, not plain time
bucketing. Time bucketing keeps each bucket's first and last sample and never
looks between them: on a measured 50-million-sample switch node it turns a
96 V overshoot into a 48 V peak. For power electronics that is the one
failure you cannot miss, so the envelope emits each signal's own minimum and
maximum per bucket, in the order they occurred.

The rule that follows: **a measurement is computed on the samples, never on
the reduction the chart is drawn from.** The chart can be an approximation; a
number with a unit after it cannot.

## Layout

- `decimate.rs` — min/max bucketing, a faithful port of the engine's
  `decimation.py`, including Python's half-to-even rounding of bucket edges.
  A spike one sample wide survives any reduction factor; averaging and
  stride sampling both destroy it.
- `manifest.rs` — the document, as serde sees it. Unknown fields are
  ignored, so a newer writer does not break an older reader.
- `source.rs` — `WaveformSource`, and the one backed by inline samples.
- `wasm.rs` — the `WaveformStore` class the viewer holds.

## Not done yet

- ~~**HDF5.**~~ Not happening, and nothing writes one any more. A
  `WaveformSource` over `data.h5` was listed here as the next
  implementation; #156 deleted the writer instead. Every HDF5 binding links a
  C library, so the WASM build this crate ships as can never read one however
  the file is compressed — which is why the reader was never finished. The
  samples live in the `.gsim_samples` container the solver writes, which this
  crate reads natively.
- **Streaming.** A live run appends; this reads a finished document.

## Building

```sh
cargo test                                   # native
wasm-pack build --target web --release       # the viewer's bundle
```
