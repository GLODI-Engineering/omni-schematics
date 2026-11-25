/**
 * Deciding which toolbar controls fit, and which move into the overflow menu.
 *
 * The arithmetic lives here, apart from the DOM, because the bug this exists to
 * end was never visible in a browser-free test. The toolbar was a single row of
 * 44 px two-line buttons with `overflow-x: auto`: in a 945 px editor pane the
 * last button rendered as `Rotat…` and the rest lived behind a 6 px scrollbar,
 * which is a thing to discover rather than a thing to use. Nothing measured the
 * row, so nothing could fail (#210).
 *
 * The rule is deliberately pessimistic about the overflow button: once anything
 * has to move, the `⋯` button itself takes room, so it is charged against the
 * budget before the first item is placed. Without that the plan can say "all
 * but one fits", add the button, and push that last one out again on the next
 * pass — a two-frame flicker that never settles.
 */

/** One toolbar child, as the planner needs it. */
export interface ToolbarMeasure {
  /** Outer width in px, horizontal margins included. */
  width: number;
  /** A separator: it carries no action, so it is never listed in the menu. */
  separator: boolean;
}

/**
 * How many leading items stay in the row.
 *
 * `available` is the row's content width — `clientWidth` less its own padding.
 * `overflowWidth` is what the `⋯` button costs, charged only when something
 * actually has to move.
 */
export function planToolbarOverflow(
  items: readonly ToolbarMeasure[],
  available: number,
  overflowWidth: number,
): number {
  if (!Number.isFinite(available) || available <= 0) {
    // No layout yet (the first pass, or a jsdom render). Showing everything is
    // the right answer: it is also the state the widths are measured in.
    return items.length;
  }

  let total = 0;
  for (const item of items) total += item.width;
  if (total <= available) return items.length;

  const budget = available - Math.max(0, overflowWidth);
  let used = 0;
  let visible = 0;
  for (const item of items) {
    if (used + item.width > budget) break;
    used += item.width;
    visible += 1;
  }
  return visible;
}

/**
 * Pull the visible count back off any separator it would end on.
 *
 * A row that ends in a divider reads as a group whose contents went missing,
 * which is exactly what happened but not what a divider should say. The same
 * rule drops a separator that would open the row.
 */
export function trimEdgeSeparators(items: readonly ToolbarMeasure[], visible: number): number {
  let end = Math.min(visible, items.length);
  while (end > 0 && items[end - 1]?.separator) end -= 1;
  return end;
}

/** The full plan: what fits, with no divider left dangling at the fold. */
export function toolbarVisibleCount(
  items: readonly ToolbarMeasure[],
  available: number,
  overflowWidth: number,
): number {
  const fitted = planToolbarOverflow(items, available, overflowWidth);
  if (fitted >= items.length) return items.length;
  return trimEdgeSeparators(items, fitted);
}
