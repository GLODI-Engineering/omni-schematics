/**
 * Held to a container the real solver wrote.
 *
 * `__fixtures__/rc-divider.gsim_samples` is the output of
 * `general-simulator 0.7.0 __fixtures__/rc-divider.cir --mode transient
 * --tfinal 2e-5 --dt 1e-6 --format samples`, committed because it is 953 bytes
 * and because a reader of a binary format tested only against bytes the test
 * itself wrote is a reader tested against its own assumptions.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SAMPLES_HEADER_BYTES,
  SamplesContainerError,
  parseSamplesFooter,
  readSamplesIndex,
} from "./samples-index";

const FIXTURE = path.join(__dirname, "__fixtures__", "rc-divider.gsim_samples");

const scratch: string[] = [];
function tempFile(bytes: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsim-samples-test-"));
  scratch.push(dir);
  const file = path.join(dir, "run.gsim_samples");
  fs.writeFileSync(file, bytes);
  return file;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readSamplesIndex", () => {
  it("names the sweep and every signal the solver wrote", () => {
    const index = readSamplesIndex(FIXTURE);
    expect(index.rows).toBe(20);
    expect(index.sweep.name).toBe("t");
    expect(index.signals.map((signal) => signal.name)).toEqual(["V(n_in)", "V(n_out)", "I(v1)"]);
  });

  it("reports the empty units the container really carries", () => {
    // Not a gap in the reader: a netlist has no units, so the solver writes
    // none. `result-manifest.ts` is where units are meant to come from, and
    // inventing volts from a `V(` prefix here would be a guess about a name
    // the engine chose.
    const index = readSamplesIndex(FIXTURE);
    expect(index.signals.every((signal) => signal.unit === "")).toBe(true);
  });

  it("never looks at a sample, so the cost does not grow with the run", () => {
    // The property `--format samples` exists for, asserted the only way that
    // does not depend on how the reads happen to be issued: every byte
    // between the header and the footer is replaced with 0xFF, and the index
    // still comes back identical. A reader that scanned the file for its
    // footer, or that touched the samples at all, cannot pass this -- and
    // would be fine on a 953-byte fixture and hopeless on a 10 GB container.
    const whole = Buffer.from(fs.readFileSync(FIXTURE));
    const footerOffset = Number(whole.readBigUInt64LE(whole.length - 16));
    whole.fill(0xff, SAMPLES_HEADER_BYTES, footerOffset);
    expect(parseSamplesFooter(whole)).toEqual(readSamplesIndex(FIXTURE));
  });
});

describe("a container that is not one", () => {
  it("says a truncated file is truncated, not that its footer is corrupt", () => {
    // The failure this format is most likely to meet, and the reason the magic
    // is at both ends: a run this extension times out and kills leaves exactly
    // this file.
    const whole = fs.readFileSync(FIXTURE);
    const file = tempFile(whole.subarray(0, whole.length - 40));
    expect(() => readSamplesIndex(file)).toThrow(SamplesContainerError);
    expect(() => readSamplesIndex(file)).toThrow(/truncated/);
  });

  it("refuses a file that does not start with the magic", () => {
    const whole = Buffer.from(fs.readFileSync(FIXTURE));
    whole.write("NOTGSIM!", 0, "latin1");
    expect(() => parseSamplesFooter(whole)).toThrow(/does not start with the GSIMSAMP magic/);
  });

  it("refuses a footer offset that points outside the file", () => {
    const whole = Buffer.from(fs.readFileSync(FIXTURE));
    whole.writeBigUInt64LE(BigInt(whole.length + 1000), whole.length - 16);
    expect(() => parseSamplesFooter(whole)).toThrow(/outside the file/);
  });

  it("refuses a file too short to hold a header and a tail", () => {
    expect(() => parseSamplesFooter(Buffer.alloc(8))).toThrow(/too short/);
  });

  it("says so when the footer is not JSON", () => {
    const footer = Buffer.from("not json at all", "utf8");
    const buffer = Buffer.alloc(SAMPLES_HEADER_BYTES + footer.length + 16);
    buffer.write("GSIMSAMP", 0, "latin1");
    footer.copy(buffer, SAMPLES_HEADER_BYTES);
    buffer.writeBigUInt64LE(BigInt(SAMPLES_HEADER_BYTES), SAMPLES_HEADER_BYTES + footer.length);
    buffer.write("GSIMSAMP", SAMPLES_HEADER_BYTES + footer.length + 8, "latin1");
    expect(() => parseSamplesFooter(buffer)).toThrow(/footer is not JSON/);
  });
});

describe("a footer from a later writer", () => {
  function footerBuffer(footer: unknown): Buffer {
    const json = Buffer.from(JSON.stringify(footer), "utf8");
    const buffer = Buffer.alloc(SAMPLES_HEADER_BYTES + json.length + 16);
    buffer.write("GSIMSAMP", 0, "latin1");
    json.copy(buffer, SAMPLES_HEADER_BYTES);
    buffer.writeBigUInt64LE(BigInt(SAMPLES_HEADER_BYTES), SAMPLES_HEADER_BYTES + json.length);
    buffer.write("GSIMSAMP", SAMPLES_HEADER_BYTES + json.length + 8, "latin1");
    return buffer;
  }

  it("is read, because adding a field is not a version bump", () => {
    // The format says so in as many words: "Adding a field to the footer is
    // not that -- the footer is JSON with unknown keys ignored."
    const index = parseSamplesFooter(
      footerBuffer({
        version: 1,
        rows: 7,
        compression: "zstd",
        sweep: { name: "t", unit: "s", quantity: "time", analysis: "tran" },
        signals: [{ name: "V(a)", unit: "V", quantity: "voltage", analysis: "tran" }],
      }),
    );
    expect(index.rows).toBe(7);
    expect(index.signals[0]).toEqual({
      name: "V(a)",
      unit: "V",
      quantity: "voltage",
      analysis: "tran",
    });
  });

  it("gives a nameless vector a name, rather than a document the schema rejects", () => {
    // `name` has `minLength: 1` in the result schema, so an empty one would
    // produce a file the viewer refuses to open — a worse answer than
    // "signal 1".
    const index = parseSamplesFooter(
      footerBuffer({ version: 1, rows: 1, sweep: {}, signals: [{}, { name: "" }] }),
    );
    expect(index.sweep.name).toBe("sweep");
    expect(index.signals.map((signal) => signal.name)).toEqual(["signal 1", "signal 2"]);
  });
});
