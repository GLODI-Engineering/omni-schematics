import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { deserialize } from "../file/deserializer";
import { SAMPLES_PER_PERIOD, shortestDeclaredPeriod, stepForDocument } from "./analysis-defaults";

const EXAMPLES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "examples",
);

const sheet = (blocks: { params?: Record<string, unknown> }[]) => ({ model: { blocks } });

describe("shortestDeclaredPeriod", () => {
  it("reads `per` and inverts `freq`, because the library spells it both ways", () => {
    // `pulsewave` takes `per`; `pwm` takes `freq`.
    expect(shortestDeclaredPeriod(sheet([{ params: { per: 1e-5 } }]))).toBe(1e-5);
    expect(shortestDeclaredPeriod(sheet([{ params: { freq: 100_000 } }]))).toBe(1e-5);
  });

  it("takes the shortest across the sheet", () => {
    const got = shortestDeclaredPeriod(
      sheet([{ params: { per: 1e-3 } }, { params: { freq: 250_000 } }, { params: { per: 1e-4 } }]),
    );
    expect(got).toBe(4e-6);
  });

  it("ignores a value that cannot be a period rather than inverting it", () => {
    // `freq: 0` would invert to infinity and swamp every real period.
    expect(shortestDeclaredPeriod(sheet([{ params: { freq: 0 } }]))).toBeNull();
    expect(shortestDeclaredPeriod(sheet([{ params: { per: -1 } }]))).toBeNull();
    expect(shortestDeclaredPeriod(sheet([{ params: { per: "1e-5" } }]))).toBeNull();
    expect(shortestDeclaredPeriod(sheet([{}]))).toBeNull();
    expect(shortestDeclaredPeriod({ model: {} })).toBeNull();
  });
});

describe("stepForDocument", () => {
  it("refines the store's step when the sheet would alias it", () => {
    // The case from #193: a 10 us period against the store's 10 us step is one
    // sample per period, always at the same phase, so the switch reads as
    // permanently off and the plot is a flat line.
    expect(stepForDocument(sheet([{ params: { per: 1e-5 } }]), 1e-5)).toBe(
      1e-5 / SAMPLES_PER_PERIOD,
    );
  });

  it("never coarsens a step the user already chose finer", () => {
    expect(stepForDocument(sheet([{ params: { per: 1e-5 } }]), 1e-9)).toBe(1e-9);
  });

  it("leaves the store's step alone when the sheet declares no period", () => {
    // A filter, an RC, a thermal network: nothing switches, and 10 us is fine.
    expect(stepForDocument(sheet([{ params: { r: 1000 } }]), 1e-5)).toBe(1e-5);
  });
});

describe("every example resolves its own fastest dynamics", () => {
  // The guard #193 asked for. These documents all declare a `simulation`
  // block, so the fallback above is not what runs them -- this checks the
  // declared step directly, which is what a user gets on pressing Run.
  const files = readdirSync(EXAMPLES).filter((name) => name.endsWith(".gsim_sch"));

  it("finds the examples", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const name of files) {
    it(name, () => {
      const document = deserialize(readFileSync(join(EXAMPLES, name), "utf8")) as unknown as {
        model: {
          blocks?: { params?: Record<string, unknown> }[];
          simulation?: {
            default_analysis?: string;
            analyses?: { id?: string; t_end?: number; t_step?: number }[];
          };
        };
      };
      const simulation = document.model.simulation;
      const analyses = simulation?.analyses ?? [];
      expect(analyses.length, "no analyses, so Run falls back to the store's step").toBeGreaterThan(
        0,
      );
      const target = simulation?.default_analysis ?? analyses[0]?.id;
      const analysis = analyses.find((entry) => entry.id === target) ?? analyses[0];
      const step = analysis?.t_step;
      expect(typeof step, "the default analysis declares no t_step").toBe("number");

      const period = shortestDeclaredPeriod(document);
      if (period === null) {
        return;
      }
      const samples = period / (step as number);
      // 20 rather than 50: the threshold is "a waveform rather than a flat
      // line", not the generator's own margin, so tightening the generators
      // later does not have to move this number.
      expect(
        samples,
        `${name} samples its ${period} s period ${samples.toFixed(1)} times`,
      ).toBeGreaterThanOrEqual(20);
    });
  }
});
