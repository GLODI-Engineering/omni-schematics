/**
 * Reading a container the real solver wrote, through the real modules.
 *
 * The fixture is `apps/vscode-extension/src/__fixtures__/rc-divider.gsim_samples`
 * — 953 bytes of `general-simulator 0.7.0` output, committed for the reason
 * `samples-index.test.ts` gives: a reader of a binary format tested only
 * against bytes the test itself wrote is a reader tested against its own
 * assumptions.
 *
 * What is substituted is the *transport* and only the transport: a
 * `RangeFetcher` backed by `fs.read` stands in for the `gsim/readSamples`
 * round trip, so the plan, the fetch, the open and the slice are the
 * production ones, in the production WebAssembly. The host's own half of that
 * round trip — which file it will open, and how much of it — is held by
 * `apps/vscode-extension/src/samples-read.test.ts`.
 */
import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initDecimator } from "../waveform/decimator";
import { ContainerSource, type RangeFetcher, SamplesSourceError } from "./samples-source";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const FIXTURE = join(
  REPO_ROOT,
  "apps",
  "vscode-extension",
  "src",
  "__fixtures__",
  "rc-divider.gsim_samples",
);

/** Every range this fetcher was asked for, so the two passes can be compared. */
interface Recorded {
  fetch: RangeFetcher;
  requests: { offset: number; length: number }[][];
  bytes: number;
}

function fileFetcher(path: string): Recorded {
  const recorded: Recorded = {
    fetch: async () => ({ size: 0, chunks: [] }),
    requests: [],
    bytes: 0,
  };
  recorded.fetch = async (ranges) => {
    recorded.requests.push(ranges.map((range) => ({ ...range })));
    const handle = openSync(path, "r");
    try {
      const size = statSync(path).size;
      const chunks = ranges.map(({ offset, length }) => {
        const buffer = new Uint8Array(length);
        readSync(handle, buffer, 0, length, offset);
        recorded.bytes += length;
        return { offset, bytes: buffer };
      });
      return { size, chunks };
    } finally {
      closeSync(handle);
    }
  };
  return recorded;
}

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeAll(async () => {
  await initDecimator();
});

describe("a .gsim_samples container, read through fetched ranges", () => {
  it("answers names, rows and extent from the prologue alone", async () => {
    // The claim that makes an opened result useful immediately: the axes can
    // be labelled and scaled before a single sample is fetched.
    const fetcher = fileFetcher(FIXTURE);
    const source = await ContainerSource.open(fetcher.fetch);
    try {
      expect(source.names()).toEqual(["V(n_in)", "V(n_out)", "I(v1)"]);
      expect(source.rows).toBe(20);
      expect(source.extent).not.toBeNull();
      const [from, to] = source.extent as [number, number];
      expect(to).toBeGreaterThan(from);
      expect(source.size).toBe(statSync(FIXTURE).size);
    } finally {
      source.close();
    }
  });

  it("opening costs three small reads, and no sample", async () => {
    const fetcher = fileFetcher(FIXTURE);
    const source = await ContainerSource.open(fetcher.fetch);
    try {
      // The size, then the tail, the footer and the prologue: four requests,
      // the first of which asks for no bytes at all.
      expect(fetcher.requests.length).toBe(4);
      expect(fetcher.requests[0]).toEqual([]);
      expect(source.bytesFetched).toBeLessThan(source.size);
    } finally {
      source.close();
    }
  });

  it("gives every signal one shared sweep grid", async () => {
    const fetcher = fileFetcher(FIXTURE);
    const source = await ContainerSource.open(fetcher.fetch);
    try {
      const names = source.names();
      const window = await source.window(names, null, 3000);
      expect(window.sweep.length).toBe(source.rows);
      expect(window.columns.length).toBe(names.length);
      for (const column of window.columns) {
        expect(column.length).toBe(window.sweep.length);
      }
      // Monotonic, because it is a sweep and not a reduction artefact.
      for (let i = 1; i < window.sweep.length; i++) {
        expect(window.sweep[i] as number).toBeGreaterThan(window.sweep[i - 1] as number);
      }
      expect(window.bytesFetched).toBeGreaterThan(0);
    } finally {
      source.close();
    }
  });

  it("reads one signal without touching another's bytes", async () => {
    // The signal-major layout, from the viewer's side: plotting one trace of
    // three must not pay for the other two. This is the property #163 chose
    // the container's axis order for, and it applies before any decimation.
    const fetcher = fileFetcher(FIXTURE);
    const source = await ContainerSource.open(fetcher.fetch);
    try {
      const one = await source.window(["V(n_out)"], null, 3000);
      const all = await source.window(source.names(), null, 3000);
      expect(one.bytesFetched).toBeLessThan(all.bytesFetched);
    } finally {
      source.close();
    }
  });

  it("asks for the same ranges twice: once recording, once for real", async () => {
    // Everything rests on this. The recording pass is answered with zeros, so
    // it can only ask for the right bytes because the decision reads no sample
    // value — only the stripe directory and index arithmetic, both of which are
    // in the prologue already.
    const fetcher = fileFetcher(FIXTURE);
    const source = await ContainerSource.open(fetcher.fetch);
    try {
      const before = fetcher.requests.length;
      const first = await source.window(source.names(), null, 3000);
      const second = await source.window(source.names(), null, 3000);
      expect(fetcher.requests.slice(before)).toEqual([
        fetcher.requests[before],
        fetcher.requests[before],
      ]);
      expect(Array.from(second.sweep)).toEqual(Array.from(first.sweep));
      expect(Array.from(second.columns[1] as Float64Array)).toEqual(
        Array.from(first.columns[1] as Float64Array),
      );
    } finally {
      source.close();
    }
  });

  it("refuses a truncated container, naming it as truncated", async () => {
    // A run this editor Stopped or timed out leaves exactly this file: the
    // footer is written last, so the trailing magic is missing. It is
    // indistinguishable from a complete one if only the head is checked, and
    // the honest answer is "the run that wrote it did not finish" rather than
    // a short window drawn as a result.
    const dir = mkdtempSync(join(tmpdir(), "gsim-truncated-"));
    scratch.push(dir);
    const path = join(dir, "run.gsim_samples");
    const whole = openSync(FIXTURE, "r");
    const size = statSync(FIXTURE).size;
    const bytes = new Uint8Array(size);
    readSync(whole, bytes, 0, size, 0);
    writeFileSync(path, bytes.subarray(0, size - 4));

    await expect(ContainerSource.open(fileFetcher(path).fetch)).rejects.toThrow(SamplesSourceError);
  });

  it("refuses a file that is not a container at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gsim-notacontainer-"));
    scratch.push(dir);
    const path = join(dir, "run.gsim_samples");
    writeFileSync(path, "this is not a sample container, it is a sentence.");
    await expect(ContainerSource.open(fileFetcher(path).fetch)).rejects.toThrow(SamplesSourceError);
  });
});
