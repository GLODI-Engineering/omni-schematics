import "@testing-library/jest-dom";

// jsdom does not implement ResizeObserver — provide a no-op stub.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom does not implement matchMedia — uPlot reads it at module load time.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// jsdom does not implement canvas, and uPlot calls getContext("2d") the
// moment it is constructed. Without this, any test that mounts a chart
// fails the run with an unhandled error even when every assertion in it
// passes — which reads as a broken test rather than a missing stub.
//
// A proxy rather than a list of methods: uPlot reaches for a different part
// of the 2D API depending on what it is drawing (`rotate` only for a
// vertical axis label, say), so an enumerated stub is a list that grows
// every time a test renders something new. Nothing here draws — these tests
// are about the DOM around the chart, never about pixels, which a real
// browser checks instead.
if (typeof HTMLCanvasElement !== "undefined") {
  const noop = () => {};
  const context = new Proxy(
    {
      // The few that must answer with something usable rather than undefined.
      measureText: (text: string) => ({ width: String(text).length * 6 }),
      getLineDash: () => [],
      createLinearGradient: () => ({ addColorStop: noop }),
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      canvas: null,
    } as Record<string, unknown>,
    {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        // Anything else is a drawing call: accept it and do nothing.
        return noop;
      },
    },
  );
  HTMLCanvasElement.prototype.getContext = (() =>
    context as unknown as CanvasRenderingContext2D) as HTMLCanvasElement["getContext"];
}

// jsdom has no Path2D either, and uPlot builds one per series while
// computing paths — before any drawing happens, so it throws during layout
// rather than during a paint that these tests do not care about.
if (typeof globalThis.Path2D === "undefined") {
  const noop = () => {};
  globalThis.Path2D = class Path2D {
    addPath = noop;
    closePath = noop;
    moveTo = noop;
    lineTo = noop;
    bezierCurveTo = noop;
    quadraticCurveTo = noop;
    arc = noop;
    arcTo = noop;
    ellipse = noop;
    rect = noop;
    roundRect = noop;
  } as unknown as typeof Path2D;
}

/**
 * The decimator, instantiated for the whole suite (#157).
 *
 * Every assertion in this repository about envelopes, budgets and surviving
 * peaks goes through `waveform/axes-config.ts`, which since #157 reduces with
 * `crates/waveform-store` compiled to WebAssembly rather than with a
 * TypeScript copy of it. Loading the bundle here is what makes those
 * assertions hold the *Rust* decimator to its behaviour — the alternative,
 * letting `reduceToBudget` pass samples through un-reduced because the module
 * never landed, would leave the entire suite green while checking nothing
 * about the reduction at all.
 *
 * The bytes are read rather than fetched for the reason `engine.test.ts`
 * gives: the bundle is `wasm-pack --target web` output whose loader fetches a
 * URL, and under jsdom `?url` resolves to an `/@fs/...` path that `fetch`
 * refuses.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { initDecimator } from "./waveform/decimator";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
await initDecimator(
  new Uint8Array(
    readFileSync(join(REPO_ROOT, "packages", "waveform-wasm", "pkg", "waveform_store_bg.wasm")),
  ),
);
