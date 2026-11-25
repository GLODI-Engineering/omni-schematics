/**
 * #210: which toolbar controls fit, and which move behind the `⋯` button.
 */
import { describe, expect, it } from "vitest";

import { type ToolbarMeasure, planToolbarOverflow, toolbarVisibleCount } from "./toolbar-overflow";

const btn = (width: number): ToolbarMeasure => ({ width, separator: false });
const sep = (): ToolbarMeasure => ({ width: 9, separator: true });

describe("planToolbarOverflow", () => {
  it("keeps everything when the row is wide enough", () => {
    const items = [btn(24), btn(24), btn(24)];
    expect(planToolbarOverflow(items, 200, 24)).toBe(3);
  });

  it("charges the overflow button against the budget the moment anything moves", () => {
    // 4x24 = 96 in a 100 px row: it "fits", but only until the ⋯ button is
    // added — and adding it would push one out again on the next pass, which
    // is a flicker that never settles.
    const items = [btn(24), btn(24), btn(24), btn(24)];
    expect(planToolbarOverflow(items, 96, 24)).toBe(4);
    expect(planToolbarOverflow(items, 95, 24)).toBe(2);
  });

  it("shows nothing rather than overlapping when not even one control fits", () => {
    expect(planToolbarOverflow([btn(80), btn(80)], 60, 24)).toBe(0);
  });

  it("shows everything before layout has happened, which is when widths are read", () => {
    // jsdom, and the first frame in a browser: `clientWidth` is 0. Hiding the
    // whole toolbar there would also mean never measuring any of it.
    const items = [btn(24), btn(24)];
    expect(planToolbarOverflow(items, 0, 24)).toBe(2);
    expect(planToolbarOverflow(items, Number.NaN, 24)).toBe(2);
  });
});

describe("toolbarVisibleCount", () => {
  it("does not leave the row ending on a divider", () => {
    // 24 + 9 fits in the 40 px budget; the plan would stop right after the
    // separator, which reads as a group whose contents went missing.
    const items = [btn(24), sep(), btn(24), btn(24)];
    expect(planToolbarOverflow(items, 64, 24)).toBe(2);
    expect(toolbarVisibleCount(items, 64, 24)).toBe(1);
  });

  it("leaves a full row alone, dividers included", () => {
    const items = [btn(24), sep(), btn(24)];
    expect(toolbarVisibleCount(items, 500, 24)).toBe(3);
  });
});
