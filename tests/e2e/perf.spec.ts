/**
 * FE-40: Performance budget E2E tests
 *
 * Budgets (from progress.frontend.yaml §FE-40):
 * - Canvas frame ≤ 16 ms p95 under 200-block drag.
 * - Quick Insert open ≤ 50 ms.
 * - Save ≤ 100 ms.
 * - Load ≤ 200 ms for 200-block model.
 */

import { expect, test } from "./fixtures/build";

/** Measure the wall-clock time of an async action in ms. */
async function measure(fn: () => Promise<void>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

/** p95 of an array of numbers. */
function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1] ?? 0;
}

test.describe("Perf budgets", () => {
  /**
   * How long the application takes to put Quick Insert on screen.
   *
   * #105 asked whether this test was a stale locator or a real defect. It was
   * both, in two separate ways, and neither was the application being slow.
   *
   * 1. **It pressed the wrong chord.** `Ctrl+Shift+.` once is the *prefix* of
   *    Quick Insert's chord, not the chord: `keymap.ts` binds
   *    `Ctrl+Shift+.,Ctrl+Shift+.` to `palette.quick-insert-azerty`, so one
   *    press only arms the pending sequence. The dialog therefore never opened
   *    and the test spent its whole 2 s in `waitForSelector`, which is the 2 s
   *    timeout CI reported. `SchematicPage.insertByName` has pressed it twice
   *    all along, and its doc comment says why.
   *
   * 2. **It timed the test runner, not the app.** `measure()` wraps
   *    `page.keyboard.press` and `page.waitForSelector` in the *runner's*
   *    `performance.now()`, so the number compared against a 50 ms budget was
   *    dominated by CDP round trips to the browser. Driven with the correct
   *    chord it measures 72–180 ms (p95 180) — a figure that says nothing about
   *    the application, since the same open measured inside the page is p95
   *    18 ms, median 6 ms. A budget on the app's latency has to be read where
   *    the app is.
   *
   * So the keystrokes stay real: Playwright presses them through the browser's
   * input pipeline, not as synthetic events, which is what keeps this a test of
   * the shipped keymap. Only the clock moves into the page — from the keydown
   * that resolves the chord to the mutation that puts the dialog in the DOM. The
   * budget is unchanged at 50 ms, and the p95-of-10 shape is unchanged.
   */
  test("Quick Insert opens in ≤ 50 ms", async ({ appPage }) => {
    const QUICK_INSERT = "[data-testid='quick-insert']";

    // Stamp every keydown, and on the mutation that first reveals the dialog
    // record the gap. The second chord press is the last keydown before it
    // appears, so the stamp is that press.
    await appPage.evaluate((selector) => {
      const win = window as unknown as {
        __qi_keydown_at?: number;
        __qi_open_ms?: number;
        __qi_reset?: () => void;
      };
      window.addEventListener(
        "keydown",
        () => {
          win.__qi_keydown_at = performance.now();
        },
        { capture: true },
      );
      new MutationObserver(() => {
        if (win.__qi_open_ms !== undefined) return;
        if (!document.querySelector(selector)) return;
        const pressedAt = win.__qi_keydown_at;
        if (pressedAt !== undefined) {
          win.__qi_open_ms = performance.now() - pressedAt;
        }
      }).observe(document.body, { childList: true, subtree: true });
      win.__qi_reset = () => {
        win.__qi_open_ms = undefined;
        win.__qi_keydown_at = undefined;
      };
    }, QUICK_INSERT);

    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      await appPage.evaluate(() => {
        (window as unknown as { __qi_reset?: () => void }).__qi_reset?.();
      });

      await appPage.keyboard.press("Control+Shift+.");
      await appPage.keyboard.press("Control+Shift+.");
      await appPage.waitForFunction(
        () => (window as unknown as { __qi_open_ms?: number }).__qi_open_ms !== undefined,
        undefined,
        { timeout: 2_000 },
      );
      samples.push(
        await appPage.evaluate(
          () => (window as unknown as { __qi_open_ms?: number }).__qi_open_ms as number,
        ),
      );

      await appPage.keyboard.press("Escape");
      await appPage.waitForSelector(QUICK_INSERT, { state: "detached", timeout: 2_000 });
    }

    const p = p95(samples);
    expect(p, `Quick Insert p95 = ${p.toFixed(1)} ms (budget: 50 ms)`).toBeLessThanOrEqual(50);
  });

  test("save ≤ 100 ms for typical model", async ({ appPage }) => {
    // Insert a small model
    await appPage.evaluate(() => {
      const win = window as unknown as { __gensim_insertBlock?: (type: string) => void };
      win.__gensim_insertBlock?.("signal.step");
    });

    const ms = await measure(async () => {
      await appPage.keyboard.press("Control+s");
      // Wait for save confirmation (toast / status bar update)
      await appPage
        .waitForFunction(
          () => {
            const fn = (window as unknown as Record<string, unknown>).__gensim_last_save_ms as
              | number
              | undefined;
            return fn !== undefined;
          },
          // The page argument. Without it the options below are passed into the predicate and
          // this wait never times out -- in a perf test, that spends the whole budget waiting.
          undefined,
          { timeout: 5_000 },
        )
        .catch(() => {
          /* not exposed — approximate */
        });
    });

    expect(ms, `Save wall-clock = ${ms.toFixed(1)} ms (budget: 100 ms)`).toBeLessThanOrEqual(100);
  });

  test("load ≤ 200 ms for 200-block model", async ({ appPage }) => {
    // Seed a 200-block model via the window helper
    await appPage.evaluate(() => {
      const fn = (window as unknown as Record<string, unknown>).__gensim_load_fixture as
        | ((name: string) => void)
        | undefined;
      fn?.("200-blocks");
    });

    const ms = await measure(async () => {
      // Reload triggers load path
      await appPage.reload();
      await appPage.waitForSelector("[data-testid='app-shell'], main", { timeout: 10_000 });
    });

    expect(ms, `Load wall-clock = ${ms.toFixed(1)} ms (budget: 200 ms)`).toBeLessThanOrEqual(200);
  });

  test("canvas p95 frame ≤ 16 ms under 200-block drag", async ({ appPage }) => {
    // Seed 200 blocks
    await appPage.evaluate(() => {
      const fn = (window as unknown as Record<string, unknown>).__gensim_load_fixture as
        | ((name: string) => void)
        | undefined;
      fn?.("200-blocks");
    });

    // Start measuring frame times via PerformanceObserver
    await appPage.evaluate(() => {
      (window as unknown as Record<string, unknown>).__frame_durations = [];
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          ((window as unknown as Record<string, unknown>).__frame_durations as number[]).push(
            entry.duration,
          );
        }
      });
      obs.observe({ type: "frame", buffered: false } as PerformanceObserverInit);
    });

    // Select all and drag
    await appPage.keyboard.press("Control+a");
    const canvas = appPage.locator("canvas, [data-testid='canvas-surface']").first();
    const bb = await canvas.boundingBox();
    if (bb) {
      await appPage.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await appPage.mouse.down();
      for (let i = 0; i < 30; i++) {
        await appPage.mouse.move(bb.x + bb.width / 2 + i * 2, bb.y + bb.height / 2 + i * 2);
      }
      await appPage.mouse.up();
    }

    const durations: number[] = await appPage.evaluate(
      () => (window as unknown as Record<string, unknown>).__frame_durations as number[],
    );

    if (durations.length > 0) {
      const p = p95(durations);
      expect(p, `Canvas p95 frame = ${p.toFixed(1)} ms (budget: 16 ms)`).toBeLessThanOrEqual(16);
    } else {
      // PerformanceObserver 'frame' not available in all browsers — skip assertion
      test.skip();
    }
  });
});
