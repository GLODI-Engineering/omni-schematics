/**
 * FE-40: Performance budget E2E tests
 *
 * Budgets (from progress.frontend.yaml §FE-40):
 * - Canvas frame ≤ 16 ms p95 under 200-block drag.
 * - Quick Insert open ≤ 50 ms.
 * - Save ≤ 100 ms.
 * - Load ≤ 200 ms for 200-block model.
 *
 * ## Every budget here is read inside the page, and that is the point (#105)
 *
 * All three of the budgets below used to be timed with `performance.now()` in
 * the **test runner**, around `page.keyboard.press` / `page.reload` /
 * `page.waitForSelector`. A Playwright call is a round trip to the browser over
 * CDP, so what those numbers mostly contained was the driver — and the budgets
 * are about the application. Measured correctly the three were:
 *
 * | budget | what the runner's clock saw | what the app actually costs |
 * |---|---|---|
 * | Quick Insert ≤ 50 ms | 72–180 ms (p95 180) | p95 18 ms, median 6 ms |
 * | save ≤ 100 ms | a keypress round trip | read from `__gensim_last_save_ms` |
 * | load ≤ 200 ms, 200 blocks | 226–688 ms of page boot | 2.3–16.6 ms |
 *
 * Two of them were therefore lying in opposite directions: the Quick Insert one
 * blamed the app for the driver, and the save one passed without ever waiting
 * for a save. The load one was worse than either — see its own comment.
 *
 * The app already measures itself: `App.tsx` writes `__gensim_perf.fixtureLoadMs`
 * and `__gensim_last_save_ms`, and both were computed and then ignored. So the
 * keystrokes and clicks here stay real, through the browser's input pipeline,
 * and only the clock lives in the page. No budget was changed to make this pass.
 */

import { expect, test } from "./fixtures/build";

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

  /**
   * How long the application takes to save, read off the app's own stopwatch.
   *
   * This test passed, and it never waited for a save. It timed
   * `page.keyboard.press("Control+s")` in the runner's clock, and the
   * `waitForFunction` that was supposed to hold it until the save landed asked
   * whether `__gensim_last_save_ms !== undefined` — but `App.tsx` initialises
   * that door to `0` on mount, so the predicate was already true on the first
   * poll and the wait returned immediately. Whatever the save then did, or
   * failed to do, the assertion saw only a CDP round trip. The `.catch()` that
   * swallowed a timeout as "not exposed — approximate" made sure of it.
   *
   * `__gensim_last_save_ms` is the duration `App.tsx` measures around
   * `saveFile()`, which is the budget's subject. Clearing it to `undefined`
   * first makes a sentinel the app never writes, so the wait now genuinely
   * waits — and if a save does not happen, this fails loudly instead of
   * reporting the keypress.
   */
  test("save ≤ 100 ms for typical model", async ({ appPage }) => {
    // Insert a small model
    await appPage.evaluate(() => {
      const win = window as unknown as { __gensim_insertBlock?: (type: string) => void };
      win.__gensim_insertBlock?.("signal.step");
      (win as { __gensim_last_save_ms?: number }).__gensim_last_save_ms = undefined;
    });

    await appPage.keyboard.press("Control+s");
    await appPage.waitForFunction(
      () =>
        typeof (window as unknown as { __gensim_last_save_ms?: number }).__gensim_last_save_ms ===
        "number",
      // The page argument. Without it the options below are passed into the predicate and
      // this wait never times out -- in a perf test, that spends the whole budget waiting.
      undefined,
      { timeout: 5_000 },
    );
    const ms = await appPage.evaluate(
      () =>
        (window as unknown as { __gensim_last_save_ms?: number }).__gensim_last_save_ms as number,
    );

    expect(ms, `Save = ${ms.toFixed(1)} ms (budget: 100 ms)`).toBeLessThanOrEqual(100);
  });

  /**
   * How long the application takes to load a 200-block document.
   *
   * #105 asked whether the 458 ms this reported meant the budget had been set
   * against a smaller fixture than `__gensim_load_fixture` now builds, or
   * whether loading 200 blocks had got slower, and said to answer that before
   * changing the number. The answer is neither, and the number did not need
   * changing: **the test never loaded a 200-block model.**
   *
   * It seeded the fixture, then called `page.reload()` and timed that. The
   * harness restores nothing on boot, so the reload threw the fixture away —
   * measured directly, after the reload the sheet holds **0 blocks** and
   * `model.id` is back to `model-1`. What the budget was being held to was a
   * cold page boot of an *empty* document: an HTTP fetch of the document from
   * the Vite preview server, the bundle downloaded and parsed, React mounted.
   * That is why it is so unstable — 226 ms on a developer machine, and 275.9 ms
   * then 687.6 ms on the same CI runner minutes apart, on identical code. It
   * had nothing to do with 200 blocks and it was never the app's load path.
   *
   * It is also not a number worth a budget here even if it were stable.
   * `index.html` is a dev/test harness and not a product surface (AGENTS.md
   * invariant 0); the editor ships inside a VS Code webview served from disk
   * over `vscode-webview://`, so the preview server's HTTP boot time measures
   * the test rig. A boot budget belongs on the webview, which Playwright cannot
   * drive.
   *
   * So this now loads the fixture and reads the app's own measurement of it —
   * `__gensim_perf.fixtureLoadMs`, which `App.tsx` has always computed around
   * `loadDocument` and which nothing ever read. It costs 2.3–16.6 ms, so the
   * 200 ms budget stands untouched with room to spare, and the test will now
   * notice if the document-load path regresses, which is what it is for.
   *
   * The block-count assertion is not decoration: without it a loader that did
   * nothing would report a very fast load and pass.
   */
  test("load ≤ 200 ms for 200-block model", async ({ appPage }) => {
    const ms = await appPage.evaluate(() => {
      const win = window as unknown as {
        __gensim_load_fixture?: (name: string) => void;
        __gensim_perf?: { fixtureLoadMs: number };
      };
      win.__gensim_load_fixture?.("200-blocks");
      return win.__gensim_perf?.fixtureLoadMs;
    });

    const blocks = await appPage.evaluate(() => {
      const serialize = (window as unknown as { __gensim_serialize?: () => string })
        .__gensim_serialize;
      const document = JSON.parse(serialize?.() ?? "{}") as { model?: { blocks?: unknown[] } };
      return document.model?.blocks?.length ?? 0;
    });
    expect(blocks, "the fixture must really be on the sheet for the timing to mean anything").toBe(
      200,
    );

    expect(ms, "the app did not report a fixture load time").toBeDefined();
    const loadMs = ms as number;
    expect(loadMs, `Load = ${loadMs.toFixed(1)} ms (budget: 200 ms)`).toBeLessThanOrEqual(200);
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
