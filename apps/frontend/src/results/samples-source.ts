/**
 * A `.gsim_samples` container, read from a webview that cannot open a file.
 *
 * The second `WaveformSource` #157 asked for, beside the inline one. What
 * makes it possible at all is the two-pass mechanism #187 landed and the
 * `SamplesFile` surface #190 exported: every offset is computed in Rust, the
 * host does nothing but fetch what it is told to, and the same call runs twice
 * — once recording which bytes it wanted, once for real.
 *
 * ## The sequence
 *
 * 1. `tailSpan(size)` → the last sixteen bytes, holding a footer offset and
 *    the trailing magic.
 * 2. `footerSpan(size, tail)` → where the footer is. **Errors here** when the
 *    trailing magic is missing, which means the run never finished writing —
 *    a run this editor timed out or Stopped leaves exactly that file, and it
 *    is otherwise indistinguishable from a complete one.
 * 3. `prologueSpans(footerJson)` → the header, stripe directory and summary.
 * 4. `new SamplesFile(size, prologue)` → opens, and fails here if the file is
 *    truncated or is not a container at all.
 *
 * Three small reads whose locations are arithmetic, and then the file is open.
 *
 * ## What the prologue alone answers
 *
 * Signal names, units, row count and extent — **before a single sample is
 * fetched**. That is what makes an opened result useful immediately: the axes
 * are labelled and scaled, and the traces fill in. A viewer that waited for
 * samples to know what it was showing would show nothing for the length of a
 * round trip, and on a multi-gigabyte container that is the whole first
 * impression.
 *
 * ## Why nothing is cached between the two passes
 *
 * It must not be. Which ranges a window reads is decided from the stripe
 * geometry, the directory and the chosen pyramid rung — index arithmetic, with
 * no sample value taking part — which is precisely why the recording pass can
 * be answered with zeros and still ask for the right bytes. A cache that
 * served a *value* from a previous window would break that equality, and the
 * second pass would read ranges the first never asked for. So each window
 * plans, fetches and slices, and the only thing held across calls is the
 * prologue.
 */

import {
  FetchedRanges,
  SamplesFile,
  type SamplesFile as SamplesFileType,
} from "@gensim/waveform-wasm";

import { initDecimator } from "../waveform/decimator";
import {
  type SamplesReadTarget,
  bytesFromBase64,
  rangesFromSpans,
  requestSamples,
} from "./samples-host";

export class SamplesSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamplesSourceError";
  }
}

/** A signal as the container labels it. Units are usually empty: a netlist has none. */
export interface SamplesSignal {
  name: string;
  unit: string;
  quantity: string;
  analysis: string;
}

/** One window: a shared sweep grid and one column per requested signal. */
export interface SamplesWindow {
  sweep: Float64Array;
  columns: Float64Array[];
  /** Bytes this window cost to fetch — the claim the format is making. */
  bytesFetched: number;
}

/**
 * How the ranges for one window are fetched.
 *
 * Injected so the whole of this module can be driven in a test against a real
 * container on disk, with `fs.read` in place of the host round trip. The
 * production implementation is `requestSamples`, and it is the default.
 */
export type RangeFetcher = (
  ranges: { offset: number; length: number }[],
) => Promise<{ size: number; chunks: { offset: number; bytes: Uint8Array }[] }>;

/** The host round trip, as a {@link RangeFetcher}. */
export function hostFetcher(target: SamplesReadTarget): RangeFetcher {
  return async (ranges) => {
    const result = await requestSamples(target, ranges);
    if (!result.ok) {
      throw new SamplesSourceError(result.summary);
    }
    return {
      size: result.size,
      chunks: result.chunks.map((chunk) => ({
        offset: chunk.offset,
        bytes: bytesFromBase64(chunk.base64),
      })),
    };
  };
}

export class ContainerSource {
  private constructor(
    private readonly file: SamplesFileType,
    private readonly fetch: RangeFetcher,
    private readonly prologue: FetchedRanges,
    /** Bytes the container occupies. */
    readonly size: number,
    readonly signals: SamplesSignal[],
    readonly rows: number,
    /** `[from, to]` of the sweep, or null for a container holding no stripes. */
    readonly extent: [number, number] | null,
    /** Bytes fetched since the file was opened, the prologue included. */
    public bytesFetched: number,
  ) {}

  /**
   * Open the container, answering every question the prologue can answer.
   *
   * `initDecimator()` first: the bundle that holds `SamplesFile` is the same
   * one that holds the envelope, so there is one module and one await.
   */
  static async open(fetch: RangeFetcher): Promise<ContainerSource> {
    await initDecimator();

    // The size, which is the one number a reader cannot derive, and the only
    // request that asks for no bytes.
    const { size } = await fetch([]);
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new SamplesSourceError(`that container is ${size} bytes, so there is nothing in it.`);
    }

    let fetched = 0;
    const read = async (spans: Float64Array, ranges = new FetchedRanges(size)) => {
      const list = rangesFromSpans(spans);
      const answer = await fetch(list);
      for (const chunk of answer.chunks) {
        ranges.put(chunk.offset, chunk.bytes);
        fetched += chunk.bytes.length;
      }
      return { ranges, list, answer };
    };

    // 1. the tail, 2. the footer, 3. the header, directory and summary.
    const tail = await read(SamplesFile.tailSpan(size));
    const tailBytes = tail.answer.chunks[0]?.bytes;
    if (!tailBytes) {
      throw new SamplesSourceError("the container's last bytes could not be read.");
    }
    let footerSpans: Float64Array;
    try {
      footerSpans = SamplesFile.footerSpan(size, tailBytes);
    } catch (error) {
      // The crate's own message, which names truncation. Kept verbatim: a run
      // that was Stopped or timed out leaves this file, and "it is truncated"
      // is the one sentence that tells the user what happened.
      throw new SamplesSourceError(messageOf(error));
    }
    const footer = await read(footerSpans, tail.ranges);
    const footerJson = new TextDecoder().decode(footer.answer.chunks[0]?.bytes ?? new Uint8Array());

    let prologueSpans: Float64Array;
    try {
      prologueSpans = SamplesFile.prologueSpans(footerJson);
    } catch (error) {
      throw new SamplesSourceError(messageOf(error));
    }
    const prologue = await read(prologueSpans, footer.ranges);

    let file: SamplesFileType;
    try {
      file = new SamplesFile(size, prologue.ranges);
    } catch (error) {
      throw new SamplesSourceError(messageOf(error));
    }

    const signals = JSON.parse(file.signalsJson()) as SamplesSignal[];
    const span = file.extent();
    return new ContainerSource(
      file,
      fetch,
      prologue.ranges,
      size,
      signals,
      file.rows(),
      span.length === 2 ? [span[0] as number, span[1] as number] : null,
      fetched,
    );
  }

  /** Every signal's name, in the container's order. */
  names(): string[] {
    return this.signals.map((signal) => signal.name);
  }

  /**
   * `names` over `[from, to]`, at most `maxPoints` points each.
   *
   * Pass no window for the whole extent. Two passes over the same question:
   * `plan` records the ranges, the fetcher answers them, `slice` runs the
   * identical call for real. They ask for the same thing because the decision
   * uses only index arithmetic and the stripe directory, which the prologue
   * already holds.
   */
  async window(
    names: string[],
    window: [number, number] | null,
    maxPoints: number,
  ): Promise<SamplesWindow> {
    const [from, to] = window ?? [undefined, undefined];
    const spans = this.file.plan(names, from, to, maxPoints);
    const ranges = rangesFromSpans(spans);

    const answer = await this.fetch(ranges);
    const fetched = new FetchedRanges(this.size);
    let bytesFetched = 0;
    try {
      for (const chunk of answer.chunks) {
        fetched.put(chunk.offset, chunk.bytes);
        bytesFetched += chunk.bytes.length;
      }
      this.bytesFetched += bytesFetched;

      const flat = this.file.slice(names, from, to, maxPoints, fetched);
      const points = flat.length / (1 + names.length);
      return {
        sweep: flat.subarray(0, points),
        columns: names.map((_, index) => flat.subarray(points * (index + 1), points * (index + 2))),
        bytesFetched,
      };
    } finally {
      // The window's bytes are WebAssembly memory and the next window will ask
      // for its own; held, they would accumulate a copy of the file one view
      // at a time, which is the thing this format exists not to do.
      fetched.free();
    }
  }

  /** Release the WebAssembly memory the open file holds. */
  close(): void {
    this.file.free();
    this.prologue.free();
  }
}

/** A `JsError` from the crate carries its message; anything else is stringified. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
