/**
 * The footer of a `.gsim_samples` container: what the run holds, and nothing
 * about where its bytes are.
 *
 * ## Why the host reads this at all
 *
 * `result-manifest.ts` writes the `.gsim_sim_result` beside the container and
 * is explicit about the division: "The container holds the samples and the
 * column names the netlist gave them. It does not hold units." So the names
 * have to come from the container, because nothing upstream of it knows them.
 * The webview compiled a netlist; the solver decided which nodes and branches
 * that netlist exposes and what to call them. A manifest written without
 * reading the container would have to either invent the signal list or ship an
 * empty one, and an empty one makes the document useless to the viewer.
 *
 * ## What is read, and what is deliberately not
 *
 * The footer only. It is the last few hundred bytes of the file whatever the
 * run's length, so this stays a two-read operation on a ten-gigabyte container
 * — which is the property `--format samples` exists for, and it would be
 * thrown away by anything here that touched a sample.
 *
 * Reading samples is not this module's job and is not the host's: that is #163
 * (the viewer reads the container directly) and #157 (one decimator, in Rust).
 *
 * ## The layout
 *
 * From the engine's own `crates/gsim-samples/src/format.rs`:
 *
 * - 16 bytes of header: `GSIMSAMP`, a `u32` version, flags.
 * - the samples, stripe by stripe.
 * - the footer: JSON, holding the geometry and the vector names.
 * - 16 bytes of tail: a little-endian `u64` offset of the footer, then
 *   `GSIMSAMP` again.
 *
 * The magic is at **both** ends on purpose, and that comment is worth
 * repeating here because it is the one failure this reader is most likely to
 * meet: "A truncated file is the failure this format is most likely to meet --
 * a run killed partway, a copy that stopped -- and it is indistinguishable
 * from a complete one if only the head is checked, because the footer offset
 * would then be read out of whatever bytes happened to land last." A run this
 * extension times out and kills is exactly that file, so both ends are
 * checked and a truncated container is reported as truncated.
 */

import * as fs from "node:fs";

export const SAMPLES_MAGIC = "GSIMSAMP";
/** `MAGIC`, `VERSION`, flags. */
export const SAMPLES_HEADER_BYTES = 16;
/** A `u64` footer offset, then `MAGIC` again. */
export const SAMPLES_TAIL_BYTES = 16;

/** A signal or the sweep axis, as the container labels it. */
export interface SamplesVector {
  name: string;
  /** Always empty from the solver: a netlist has no units. Carried as it is. */
  unit: string;
  quantity: string;
  analysis: string;
}

/** The footer, narrowed to what a manifest writer needs of it. */
export interface SamplesIndex {
  version: number;
  /** Samples per signal across the whole run. */
  rows: number;
  sweep: SamplesVector;
  signals: SamplesVector[];
}

export class SamplesContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamplesContainerError";
  }
}

function vector(raw: unknown, fallbackName: string): SamplesVector {
  const fields = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    // A nameless vector would make a manifest the schema rejects (`name` has
    // `minLength: 1`), so an index is better than an empty string: the user
    // sees "signal 3" rather than a document that will not open.
    name: text(fields.name) || fallbackName,
    unit: text(fields.unit),
    quantity: text(fields.quantity),
    analysis: text(fields.analysis),
  };
}

/**
 * Parse a container's footer out of its last bytes.
 *
 * Takes the whole file rather than a window because the caller that has a
 * `Buffer` has it from a positioned read; {@link readSamplesIndex} is the one
 * that does the two reads, and this is the half worth testing.
 */
export function parseSamplesFooter(buffer: Buffer): SamplesIndex {
  if (buffer.length < SAMPLES_HEADER_BYTES + SAMPLES_TAIL_BYTES) {
    throw new SamplesContainerError(
      `too short to be a .gsim_samples container (${buffer.length} bytes)`,
    );
  }
  if (buffer.subarray(0, 8).toString("latin1") !== SAMPLES_MAGIC) {
    throw new SamplesContainerError("does not start with the GSIMSAMP magic");
  }
  if (buffer.subarray(buffer.length - 8).toString("latin1") !== SAMPLES_MAGIC) {
    throw new SamplesContainerError(
      "does not end with the GSIMSAMP magic, so it is truncated — the run " +
        "that wrote it did not finish",
    );
  }

  const offset = buffer.readBigUInt64LE(buffer.length - SAMPLES_TAIL_BYTES);
  const end = BigInt(buffer.length - SAMPLES_TAIL_BYTES);
  if (offset < BigInt(SAMPLES_HEADER_BYTES) || offset > end) {
    throw new SamplesContainerError(
      `names a footer at byte ${offset}, which is outside the file (${buffer.length} bytes)`,
    );
  }

  const text = buffer.subarray(Number(offset), Number(end)).toString("utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new SamplesContainerError(
      `its footer is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SamplesContainerError("its footer is not a JSON object");
  }
  const fields = raw as Record<string, unknown>;
  const signals = Array.isArray(fields.signals) ? fields.signals : [];

  return {
    // Not rejected when it is not 1. The format's own note is that "adding a
    // field to the footer is not" a version bump, so a later writer that only
    // added fields still answers the two questions asked here, and refusing it
    // would break a run that worked.
    version: typeof fields.version === "number" ? fields.version : 0,
    rows: typeof fields.rows === "number" ? fields.rows : 0,
    sweep: vector(fields.sweep, "sweep"),
    signals: signals.map((entry, index) => vector(entry, `signal ${index + 1}`)),
  };
}

/**
 * Read the footer of the container at `file`, touching no samples.
 *
 * Two positioned reads: the last 16 bytes to learn where the footer starts,
 * then the footer itself. The header's magic is read with it, so the same
 * `parseSamplesFooter` checks both ends.
 */
export function readSamplesIndex(file: string): SamplesIndex {
  const handle = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(handle).size;
    if (size < SAMPLES_HEADER_BYTES + SAMPLES_TAIL_BYTES) {
      throw new SamplesContainerError(
        `${file} is too short to be a .gsim_samples container (${size} bytes)`,
      );
    }
    const tail = Buffer.alloc(SAMPLES_TAIL_BYTES);
    fs.readSync(handle, tail, 0, SAMPLES_TAIL_BYTES, size - SAMPLES_TAIL_BYTES);
    if (tail.subarray(8).toString("latin1") !== SAMPLES_MAGIC) {
      throw new SamplesContainerError(
        `${file} does not end with the GSIMSAMP magic, so it is truncated — ` +
          "the run that wrote it did not finish",
      );
    }
    const offset = Number(tail.readBigUInt64LE(0));
    if (offset < SAMPLES_HEADER_BYTES || offset > size - SAMPLES_TAIL_BYTES) {
      throw new SamplesContainerError(
        `${file} names a footer at byte ${offset}, which is outside the file (${size} bytes)`,
      );
    }

    // The head and the footer, in one buffer shaped like the file so the parse
    // above can be the only place that knows the layout. The gap between them
    // is never looked at: it is the samples, and this module does not read
    // samples.
    const footerBytes = size - SAMPLES_TAIL_BYTES - offset;
    const buffer = Buffer.alloc(SAMPLES_HEADER_BYTES + footerBytes + SAMPLES_TAIL_BYTES);
    fs.readSync(handle, buffer, 0, SAMPLES_HEADER_BYTES, 0);
    fs.readSync(handle, buffer, SAMPLES_HEADER_BYTES, footerBytes, offset);
    tail.copy(buffer, SAMPLES_HEADER_BYTES + footerBytes);
    // The offset in the copy is where the footer actually is in the copy.
    buffer.writeBigUInt64LE(BigInt(SAMPLES_HEADER_BYTES), SAMPLES_HEADER_BYTES + footerBytes);
    return parseSamplesFooter(buffer);
  } finally {
    fs.closeSync(handle);
  }
}
