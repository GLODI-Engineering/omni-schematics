/**
 * The host's half of plotting a container (#157).
 *
 * Driven against `__fixtures__/rc-divider.gsim_samples` — a container the real
 * solver wrote — and against the paths a webview might name, because the two
 * things this module decides are *which file* and *how much of it*, and both
 * are decided on behalf of a message from outside.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_SAMPLES_READ_BYTES,
  SamplesReadError,
  checkRanges,
  fileSystemPath,
  readSamplesRanges,
  resolveSamplesPath,
} from "./samples-read";

const FIXTURE_DIR = path.join(__dirname, "__fixtures__");
const FIXTURE = path.join(FIXTURE_DIR, "rc-divider.gsim_samples");
const FIXTURE_BYTES = fs.statSync(FIXTURE).size;

const scratch: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsim-samples-read-"));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readSamplesRanges", () => {
  it("answers the size alone when asked for no ranges", () => {
    // The one number a reader cannot work out for itself, and the first thing
    // `SamplesFile` needs: every span it computes afterwards is relative to it.
    const answer = readSamplesRanges({ path: FIXTURE, ranges: [] }, { roots: [FIXTURE_DIR] });
    expect(answer.size).toBe(FIXTURE_BYTES);
    expect(answer.chunks).toEqual([]);
  });

  it("reads the bytes at the offsets it was given, and nothing else", () => {
    const answer = readSamplesRanges(
      {
        path: FIXTURE,
        ranges: [
          { offset: 0, length: 8 },
          { offset: FIXTURE_BYTES - 8, length: 8 },
        ],
      },
      { roots: [FIXTURE_DIR] },
    );
    // Head and tail magic, which is where this container's own integrity check
    // lives — so these are the two ranges `SamplesFile` asks for first.
    expect(Buffer.from(answer.chunks[0]?.bytes ?? []).toString("latin1")).toBe("GSIMSAMP");
    expect(Buffer.from(answer.chunks[1]?.bytes ?? []).toString("latin1")).toBe("GSIMSAMP");
    expect(answer.chunks.map((chunk) => chunk.offset)).toEqual([0, FIXTURE_BYTES - 8]);
  });

  it("keeps the ranges in the order they were asked for", () => {
    // `FetchedRanges.put` is keyed by offset, so order is not load-bearing for
    // correctness — but the reply pairs each chunk with its offset, and a
    // reader that trusted position over offset would be silently wrong.
    const answer = readSamplesRanges(
      {
        path: FIXTURE,
        ranges: [
          { offset: 32, length: 4 },
          { offset: 16, length: 4 },
        ],
      },
      { roots: [FIXTURE_DIR] },
    );
    expect(answer.chunks.map((chunk) => chunk.offset)).toEqual([32, 16]);
  });
});

describe("what a bad request cannot do", () => {
  it("refuses a length that would allocate a gigabyte", () => {
    // `length` arrives from a webview, and a webview that computed an offset
    // wrongly asks for a gigabyte as readily as for a kilobyte. The point is
    // never to allocate it, so this fails before any buffer is asked for.
    expect(() => checkRanges([{ offset: 0, length: 1024 ** 3 }], 2 * 1024 ** 3)).toThrow(
      /is the most this reads at once/,
    );
  });

  it("refuses a total over the cap even when every range is small", () => {
    const ranges = Array.from({ length: 2000 }, () => ({
      offset: 0,
      length: Math.ceil(MAX_SAMPLES_READ_BYTES / 1000),
    }));
    expect(() => checkRanges(ranges, MAX_SAMPLES_READ_BYTES * 4)).toThrow(/in one request/);
  });

  it("refuses more ranges than a plan could coalesce to", () => {
    const ranges = Array.from({ length: 5000 }, (_, i) => ({ offset: i, length: 1 }));
    expect(() => checkRanges(ranges, 1024 ** 2)).toThrow(/ranges in one request/);
  });

  it("refuses a range that runs off the end of the file", () => {
    expect(() =>
      readSamplesRanges(
        { path: FIXTURE, ranges: [{ offset: FIXTURE_BYTES - 4, length: 64 }] },
        { roots: [FIXTURE_DIR] },
      ),
    ).toThrow(/outside|of a \d+-byte container/);
  });

  it("refuses a negative or fractional range", () => {
    expect(() => checkRanges([{ offset: -1, length: 8 }], 100)).toThrow(/negative/);
    expect(() => checkRanges([{ offset: 0, length: 1.5 }], 100)).toThrow(/whole numbers/);
  });
});

describe("which file a webview may name", () => {
  it("reads a container inside a workspace folder", () => {
    expect(resolveSamplesPath({ path: FIXTURE }, { roots: [FIXTURE_DIR] })).toBe(FIXTURE);
  });

  it("refuses one outside every root", () => {
    const elsewhere = path.join(tempDir(), "run.gsim_samples");
    fs.writeFileSync(elsewhere, "nope");
    expect(() => resolveSamplesPath({ path: elsewhere }, { roots: [FIXTURE_DIR] })).toThrow(
      SamplesReadError,
    );
  });

  it("refuses anything that is not a .gsim_samples", () => {
    // Narrow on purpose: this message is answered for any webview in the
    // window, so "any file the workspace contains" would be a general-purpose
    // file reader reachable from a document.
    expect(() =>
      resolveSamplesPath(
        { path: path.join(FIXTURE_DIR, "rc-divider.cir") },
        { roots: [FIXTURE_DIR] },
      ),
    ).toThrow(/only \.gsim_samples/);
  });

  it("resolves a relative path against the document that named it", () => {
    // What a `.gsim_sim_result` carries: `data.path`, relative to itself. Only
    // the host knows where that document is on disk.
    const resolved = resolveSamplesPath(
      {
        path: "rc-divider.gsim_samples",
        relativeTo: `file://${FIXTURE_DIR}/result.gsim_sim_result`,
      },
      { roots: [] },
    );
    expect(resolved).toBe(FIXTURE);
  });

  it("refuses a relative path that climbs out of that directory", () => {
    // `path.resolve` collapses the `..` before the containment check, so an
    // escape is caught rather than normalised into something that passes.
    expect(() =>
      resolveSamplesPath(
        {
          path: "../../../../etc/secrets.gsim_samples",
          relativeTo: `file://${FIXTURE_DIR}/result.gsim_sim_result`,
        },
        { roots: [] },
      ),
    ).toThrow(/outside this window's workspace folders/);
  });

  it("refuses an empty path and one carrying a NUL", () => {
    expect(() => resolveSamplesPath({ path: "" }, { roots: [FIXTURE_DIR] })).toThrow(
      /no container was named/,
    );
    expect(() =>
      resolveSamplesPath({ path: "run\0.gsim_samples" }, { roots: [FIXTURE_DIR] }),
    ).toThrow(/not a path/);
  });

  it("decodes a file URI, percent-escapes and all", () => {
    expect(fileSystemPath("file:///home/a%20b/run.gsim_sim_result")).toBe(
      "/home/a b/run.gsim_sim_result",
    );
  });
});
