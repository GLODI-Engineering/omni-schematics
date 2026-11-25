/**
 * The decimator, inside the viewer.
 *
 * `crates/waveform-store` compiled to WebAssembly — the same Rust the solver's
 * writer builds its pyramid with and the same code a server would answer a
 * window with. Before #157 this file's job was done by a hand-maintained
 * TypeScript copy of `minmax_envelope` in `waveform/axes-config.ts`, whose own
 * comment said "Mirrors `minmax_envelope` in
 * `crates/waveform-store/src/decimate.rs`". The crate's header says why that
 * is worth ending: with more than one implementation "a trace could change
 * shape depending on which one produced it, and a difference between the
 * browser's view and the server's was indistinguishable from a bug in the
 * simulation".
 *
 * ## Why the module is a singleton with an async door and a sync call
 *
 * `WebAssembly.instantiate` is asynchronous; reducing an array is not, and the
 * reduction runs inside a React effect on every zoom, pan and resize. So the
 * shape that fits is the one `engine/engine.ts` already uses: await the module
 * once, then call it synchronously for the rest of the session.
 *
 * Every path that puts samples where a chart can see them awaits
 * {@link initDecimator} first — a finished run, an opened `.gsim_sim_result`,
 * a container window — and `Axes` awaits it on mount. {@link reduceToBudget}
 * is nevertheless safe to call before it has landed: it hands the samples back
 * whole. That is not a second implementation to drift from the first, it is
 * *no* reduction, which draws the same picture and merely costs more to draw,
 * and it lasts only until the module is in the page. The alternative — throw,
 * or return nothing — would turn a 200 ms race into a blank plot, which is the
 * one outcome FE-146 says must never be presented as a result.
 *
 * ## Why `initDecimator` takes an optional source
 *
 * The bundle is `wasm-pack --target web` output, whose loader fetches a URL.
 * That is right in the webview and wrong in a test runner: `fetch` of an
 * `/@fs/...` path fails under jsdom. `apps/frontend/src/test-setup.ts` hands
 * the bytes in instead, so the whole frontend suite — every existing
 * assertion about envelopes, peaks and budgets — runs against this bundle
 * rather than against a stub. The webview never passes anything.
 */

import init, { minmaxEnvelope } from "@gensim/waveform-wasm";
import wasmUrl from "@gensim/waveform-wasm/wasm?url";

let ready: Promise<void> | null = null;
let loaded = false;

/** The initialised decimator. Idempotent; the first caller pays for the fetch. */
export function initDecimator(source?: BufferSource | WebAssembly.Module): Promise<void> {
  const pending =
    ready ??
    init({ module_or_path: source ?? wasmUrl }).then(() => {
      loaded = true;
    });
  ready = pending;
  return pending;
}

/** True once {@link reduceToBudget} is reducing rather than passing through. */
export function decimatorLoaded(): boolean {
  return loaded;
}

/** For tests: forget the instantiated module so the next `initDecimator` re-runs. */
export function resetDecimatorForTests(): void {
  ready = null;
  loaded = false;
}

/**
 * Min/max envelope on a shared time grid, at most `maxPoints` points.
 *
 * ## What the guarantee is
 *
 * Every original sample lies inside the band drawn for its bucket. Nothing the
 * signal did is hidden outside what is on screen. Averaging and stride
 * sampling both fail that — either can draw a calm line through a region where
 * the signal was swinging — and in power electronics the sample that is lost
 * that way is the overshoot that destroys the device.
 *
 * The *time* axis is bucketed, so every signal shares one grid, which is what
 * uPlot draws against; within each bucket every signal contributes its own
 * minimum and maximum, emitted in the order they occurred so a rising edge
 * still reads as rising. All of that is `decimate.rs`'s doing, not this
 * file's — this is the boundary and nothing else.
 */
export function reduceToBudget(
  time: Float64Array,
  columns: Float64Array[],
  maxPoints: number,
): { time: Float64Array; columns: Float64Array[] } {
  const rows = time.length;
  if (!loaded || rows <= maxPoints || maxPoints < 4) {
    // The second and third conditions are the crate's own early return, and
    // short-circuiting them here saves copying the samples across the boundary
    // to be handed straight back. `decimate.rs` is held to the same answer by
    // `the_envelope_hands_back_small_data_untouched`.
    return { time, columns };
  }

  // One flat buffer in, one flat buffer out: a conversion per column at the
  // boundary is the cost this shape exists to avoid, and the caller knows both
  // counts.
  const flat = new Float64Array(rows * columns.length);
  for (let c = 0; c < columns.length; c++) {
    const column = columns[c] as Float64Array;
    // A column shorter than the grid means a signal arrived mid-flight; the
    // missing tail stays zero rather than reading off the end of the buffer.
    flat.set(column.length === rows ? column : column.subarray(0, rows), c * rows);
  }

  const reduced = minmaxEnvelope(time, flat, columns.length, maxPoints);
  const points = columns.length === 0 ? reduced.length : reduced.length / (1 + columns.length);
  return {
    time: reduced.subarray(0, points),
    columns: columns.map((_, index) =>
      reduced.subarray(points * (index + 1), points * (index + 2)),
    ),
  };
}
