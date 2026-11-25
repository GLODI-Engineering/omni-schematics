/* tslint:disable */
/* eslint-disable */

/**
 * Bytes the host fetched, on their way back in.
 *
 * A handle rather than one big argument because the ranges arrive one reply
 * at a time: the viewer plans, the host answers each range, and each answer
 * is put here as it lands. Passing them as a single concatenated buffer would
 * mean the caller rebuilding the offsets this already knows.
 */
export class FetchedRanges {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Bytes held — what the last read actually cost to fetch.
     */
    bytesHeld(): number;
    constructor(size: number);
    /**
     * One fetched range. `offset` is a file offset; a `f64` carries any
     * integer below 2^53, which is nine petabytes.
     */
    put(offset: number, bytes: Uint8Array | number[]): void;
}

/**
 * A `.gsim_samples` file, read through ranges somebody else fetches.
 *
 * The viewer cannot read a file and the host cannot decimate (#175), so this
 * is the half that knows *which bytes are needed*. The sequence is:
 *
 * 1. [`SamplesFile::tailSpan`], then [`SamplesFile::footerSpan`], then
 *    [`SamplesFile::prologueSpans`] — three small reads whose locations are
 *    arithmetic, fetched by the host.
 * 2. `new SamplesFile(size, prologue)`, which opens the file and fails here
 *    if it is truncated or not one.
 * 3. [`SamplesFile::plan`] for a window, then the host fetches those ranges,
 *    then [`SamplesFile::slice`] returns the points.
 *
 * Every offset in that sequence is computed here. The caller fetches and
 * does no arithmetic, which is the point: there is one implementation of the
 * layout and it is the one the writer agrees with.
 */
export class SamplesFile {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * `[from, to]`, taken from the stripe directory rather than any sample.
     * Empty when the file holds no stripes.
     */
    extent(): Float64Array;
    /**
     * Where the footer is, from those sixteen bytes. Errors on a missing
     * trailing magic, which means the run never finished writing.
     */
    static footerSpan(size: number, tail: Uint8Array | number[]): Float64Array;
    constructor(size: number, prologue: FetchedRanges);
    /**
     * The ranges a window would read, as `[offset, len, …]`, coalesced.
     *
     * A recording pass: the answer depends on the stripe geometry, the
     * directory and the rung, all of which are in the prologue already — no
     * sample value takes part, which is why the second pass asks for exactly
     * these.
     */
    plan(names: string[], from: number | null | undefined, to: number | null | undefined, max_points: number): Float64Array;
    /**
     * The header, stripe directory and summary, from the footer's JSON.
     */
    static prologueSpans(footer_json: string): Float64Array;
    /**
     * Samples per signal in the run — not the number of points a read returns.
     */
    rows(): number;
    /**
     * The signals this file holds, as JSON: `[{name, unit, quantity, analysis}]`.
     */
    signalsJson(): string;
    /**
     * The window, from ranges a [`SamplesFile::plan`] asked for.
     *
     * Flat: `[sweep…, signal0…, …]`, for the reason the inline store's slice
     * is flat — the caller knows how many signals it asked for and can
     * subarray one buffer at no cost.
     */
    slice(names: string[], from: number | null | undefined, to: number | null | undefined, max_points: number, fetched: FetchedRanges): Float64Array;
    /**
     * The last sixteen bytes: a footer offset and the trailing magic.
     */
    static tailSpan(size: number): Float64Array;
}

export class WaveformStore {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Read a `.gsim_sim_result` whose samples are inline.
     */
    constructor(manifest_json: string);
    /**
     * The signals this result holds, as JSON: `[{name, unit, quantity, analysis}]`.
     *
     * JSON rather than a typed array of objects because it is read once per
     * opened file, where a typed boundary would cost more in generated glue
     * than it saves.
     */
    signalsJson(): string;
    /**
     * `[sweep…, signal0…, …]` for `names` over `[from, to]`, at most
     * `max_points` samples each.
     *
     * Pass `from`/`to` as `undefined` for the whole extent.
     */
    slice(names: string[], from: number | null | undefined, to: number | null | undefined, max_points: number): Float64Array;
    sweepDomain(): string;
}

/**
 * Reduce samples already in the page to a point budget, peak-preserving.
 *
 * ## Why this is here as well as [`SamplesFile::slice`]
 *
 * A container is not the only way samples reach the viewer. A
 * `kind: "inline"` result carries them in the document, a capture replayed
 * from a file is read by the editor, and a previous run kept for an overlay
 * is already in memory. All of those still have to be reduced to what a plot
 * can show, and before this they were reduced by a hand-maintained
 * TypeScript copy of [`crate::decimate::minmax_envelope`] whose own comment
 * said so (#157). One algorithm means one of them, and the one that survives
 * is the one the writer and the server already agree with.
 *
 * Flat in and flat out, for the reason a slice is flat: `columns` is
 * `column_count` runs of `time.len()` values laid end to end, and the result
 * is `[time…, column0…, column1…, …]` over however many points the budget
 * left. The caller knows both counts, so it can subarray one buffer at no
 * cost instead of paying for an object per column at the boundary.
 */
export function minmaxEnvelope(time: Float64Array | number[], columns: Float64Array | number[], column_count: number, max_points: number): Float64Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_fetchedranges_free: (a: number, b: number) => void;
    readonly __wbg_samplesfile_free: (a: number, b: number) => void;
    readonly __wbg_waveformstore_free: (a: number, b: number) => void;
    readonly fetchedranges_bytesHeld: (a: number) => number;
    readonly fetchedranges_new: (a: number) => number;
    readonly fetchedranges_put: (a: number, b: number, c: number, d: number) => void;
    readonly minmaxEnvelope: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly samplesfile_extent: (a: number) => [number, number, number];
    readonly samplesfile_footerSpan: (a: number, b: number, c: number) => [number, number, number];
    readonly samplesfile_new: (a: number, b: number) => [number, number, number];
    readonly samplesfile_plan: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly samplesfile_prologueSpans: (a: number, b: number) => [number, number, number];
    readonly samplesfile_rows: (a: number) => [number, number, number];
    readonly samplesfile_signalsJson: (a: number) => [number, number, number, number];
    readonly samplesfile_slice: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly samplesfile_tailSpan: (a: number) => any;
    readonly waveformstore_new: (a: number, b: number) => [number, number, number];
    readonly waveformstore_signalsJson: (a: number) => [number, number];
    readonly waveformstore_slice: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly waveformstore_sweepDomain: (a: number) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
